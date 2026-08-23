"""Outcome Engine wire contracts and in-process sweeper task orchestration."""

from __future__ import annotations

import inspect
import asyncio
import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError


DELIVER_TOPIC = "OUTCOME.DELIVERY.COMMANDS.DELIVER"
NEW_TASK_TOPIC = "OUTCOME.DELIVERY.FULLFILLER.NOTIFICATIONS.NEW-TASK-TO-BE-DONE"
TASK_ACKNOWLEDGED_TOPIC = "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-ACKNOWLEDGED"
TASK_DONE_TOPIC = "OUTCOME.DELIVERY.FULLFILLER.REPLIES.TASK-DONE"
FULFILLER_NAME = "sweeper-agent"


class Publisher(Protocol):
    async def publish(
        self,
        topic: str,
        payload: dict[str, Any],
        attributes: dict[str, str] | None = None,
    ) -> str: ...


class BrokerAck(Protocol):
    def ack(self) -> None: ...

    def nack(self) -> None: ...


class SweepExecutor(Protocol):
    async def generate_candidates(self, count: int) -> list[str]: ...

    async def review_handles(self, handles: list[str], mode: str) -> list[dict[str, Any]]: ...

    async def apply_unfollow(self, handle: str) -> dict[str, Any]: ...

    async def apply_unfollows(self, reviews: list[dict[str, Any]]) -> list[dict[str, Any]]: ...


ContextLoader = Callable[[str], Awaitable[dict[str, Any]] | dict[str, Any]]


class NewTask(BaseModel):
    """Language-neutral JSON contract emitted by Outcome Engine."""

    model_config = ConfigDict(extra="ignore")

    source_type: str = Field(alias="sourceType")
    source_id: str = Field(alias="sourceId")
    entity_type: str | None = Field(default=None, alias="entityType")
    entity_id: str | None = Field(default=None, alias="entityId")
    fulfiller_name: str = Field(alias="fulfillerName")
    outcome_delivery_id: str = Field(alias="outcomeDeliveryId")
    od_task_id: str = Field(alias="odTaskId")
    outcome_task_name: str = Field(alias="outcomeTaskName")
    outcome_name: str = Field(alias="outcomeName")
    requirements: list[dict[str, Any]] = Field(default_factory=list)


def sweep_delivery_command(sweep_id: str, mode: str, count: int) -> dict[str, Any]:
    """Build the publisher-owned, delivery-pinned sweep flow."""

    steps = [
        {
            "id": "generate-candidates",
            "name": "generate-candidates",
            "type": "task",
            "fulfiller": {"id": FULFILLER_NAME, "name": FULFILLER_NAME},
            "requirements": [],
            "continueFlowOnFail": False,
        },
        {
            "id": "review-handles",
            "name": "review-handles",
            "type": "task",
            "fulfiller": {"id": FULFILLER_NAME, "name": FULFILLER_NAME},
            "requirements": [],
            "continueFlowOnFail": False,
        },
    ]
    adjacency = [{"from": "generate-candidates", "to": "review-handles"}]
    if mode == "auto-unfollow":
        steps.append(
            {
                "id": "apply-unfollows",
                "name": "apply-unfollows",
                "type": "task",
                "fulfiller": {"id": FULFILLER_NAME, "name": FULFILLER_NAME},
                "requirements": [],
                "continueFlowOnFail": False,
            }
        )
        adjacency.extend(
            [
                {"from": "review-handles", "to": "apply-unfollows"},
                {"from": "apply-unfollows", "to": "END"},
            ]
        )
    else:
        adjacency.append({"from": "review-handles", "to": "END"})

    return {
        "sourceType": "x-sweep-run",
        "sourceId": sweep_id,
        "prospectId": None,
        "outcomeName": "sweep-run",
        "outcomeDeliveryContext": {
            "origin": FULFILLER_NAME,
            "params": {"mode": mode, "count": count},
        },
        "flow": {
            "id": "default",
            "name": "sweep-run-default",
            "definitionVersion": "v1",
            "steps": steps,
            "adjacencyList": adjacency,
        },
    }


def unfollow_delivery_command(
    unfollow_id: str,
    sweep_id: str,
    sweep_delivery_id: str,
    handle: str,
) -> dict[str, Any]:
    """Build a separately user-triggered delivery for one reviewed decision."""

    return {
        "sourceType": "x-sweep-unfollow",
        "sourceId": unfollow_id,
        "prospectId": None,
        "outcomeName": "sweep-unfollow",
        "outcomeDeliveryContext": {
            "origin": FULFILLER_NAME,
            "sweepId": sweep_id,
            "sweepDeliveryId": sweep_delivery_id,
            "handle": handle,
        },
        "flow": {
            "id": "default",
            "name": "sweep-unfollow-default",
            "definitionVersion": "v1",
            "steps": [
                {
                    "id": "apply-unfollow",
                    "name": "apply-unfollow",
                    "type": "task",
                    "fulfiller": {"id": FULFILLER_NAME, "name": FULFILLER_NAME},
                    "requirements": [],
                    "continueFlowOnFail": False,
                }
            ],
            "adjacencyList": [{"from": "apply-unfollow", "to": "END"}],
        },
    }


@dataclass
class TaskLedgerEntry:
    state: str = "working"
    done_payload: dict[str, Any] | None = None


@dataclass
class InMemoryTaskLedger:
    """Records terminal replies so an in-process Pub/Sub redelivery can replay them."""

    entries: dict[str, TaskLedgerEntry] = field(default_factory=dict)

    def claim(self, od_task_id: str) -> tuple[bool, TaskLedgerEntry]:
        existing = self.entries.get(od_task_id)
        if existing is not None:
            return False, existing
        entry = TaskLedgerEntry()
        self.entries[od_task_id] = entry
        return True, entry

    def release(self, od_task_id: str, entry: TaskLedgerEntry) -> None:
        if self.entries.get(od_task_id) is entry:
            del self.entries[od_task_id]


class SweepTaskHandler:
    """Consumes NEW-TASK and emits Outcome Engine acknowledgement/completion replies."""

    def __init__(
        self,
        publisher: Publisher,
        executor: SweepExecutor,
        context_loader: ContextLoader,
        ledger: InMemoryTaskLedger | None = None,
    ) -> None:
        self.publisher = publisher
        self.executor = executor
        self.context_loader = context_loader
        self.ledger = ledger or InMemoryTaskLedger()

    async def handle(
        self,
        data: bytes,
        attributes: dict[str, str],
        broker_ack: BrokerAck,
    ) -> None:
        """Handle one Pub/Sub delivery using work-then-ack semantics."""

        if attributes.get("fulfiller-name") not in (None, FULFILLER_NAME):
            broker_ack.ack()
            return

        try:
            task = NewTask.model_validate_json(data)
        except ValidationError:
            # A malformed task cannot become executable through redelivery. Match the
            # reference fulfiller's poison-message behavior and drop it deliberately.
            broker_ack.ack()
            return
        if task.fulfiller_name != FULFILLER_NAME:
            broker_ack.ack()
            return

        fresh, entry = self.ledger.claim(task.od_task_id)
        if not fresh:
            if entry.state == "done" and entry.done_payload is not None:
                await self.publisher.publish(TASK_DONE_TOPIC, entry.done_payload)
                broker_ack.ack()
            else:
                # With max-outstanding-messages=1 this should only be transient. Do not
                # discard a duplicate unless a terminal response can be replayed.
                broker_ack.nack()
            return

        try:
            await self.publisher.publish(
                TASK_ACKNOWLEDGED_TOPIC,
                {
                    "fulfillerName": FULFILLER_NAME,
                    "odTaskId": task.od_task_id,
                    "acknowledgedAt": datetime.now(timezone.utc).isoformat(),
                },
            )
        except Exception:
            self.ledger.release(task.od_task_id, entry)
            raise

        try:
            context = self.context_loader(task.outcome_delivery_id)
            if inspect.isawaitable(context):
                context = await context
            patch = await self._execute(task, context)
            done = self._done(task, "SUCCESS", None, patch)
        except Exception as exc:
            done = self._done(task, "FAILURE", str(exc), None)

        try:
            await self.publisher.publish(TASK_DONE_TOPIC, done)
        except Exception:
            # Keep the broker message outstanding. The next delivery may safely retry;
            # durable execute-mode idempotency is a separate persistence boundary.
            self.ledger.release(task.od_task_id, entry)
            raise
        entry.state = "done"
        entry.done_payload = done
        # ACK the broker only after the terminal reply has been accepted. A crash before
        # this line leaves the message available for Pub/Sub redelivery.
        broker_ack.ack()

    async def _execute(self, task: NewTask, context: dict[str, Any]) -> dict[str, Any]:
        params = context.get("params", {})
        if task.outcome_task_name == "generate-candidates":
            candidates = await self.executor.generate_candidates(int(params.get("count", 30)))
            return {"candidates": candidates}
        if task.outcome_task_name == "review-handles":
            candidates = context.get("candidates", [])
            reviews = await self.executor.review_handles(candidates, str(params.get("mode", "dry-run")))
            return {"reviews": reviews}
        if task.outcome_task_name == "apply-unfollow":
            handle = str(context.get("handle", ""))
            if not handle:
                raise ValueError("MISSING_UNFOLLOW_HANDLE")
            return {"unfollow": await self.executor.apply_unfollow(handle)}
        if task.outcome_task_name == "apply-unfollows":
            reviews = context.get("reviews", [])
            if not isinstance(reviews, list):
                raise ValueError("MISSING_REVIEWS")
            return {"unfollows": await self.executor.apply_unfollows(reviews)}
        raise ValueError(f"UNKNOWN_TASK: {task.outcome_task_name}")

    @staticmethod
    def _done(
        task: NewTask,
        result_code: str,
        completion_detail: str | None,
        context_patch: dict[str, Any] | None,
    ) -> dict[str, Any]:
        return {
            "odTaskId": task.od_task_id,
            "outcomeDeliveryId": task.outcome_delivery_id,
            "resultCode": result_code,
            "completionDetail": completion_detail,
            "contextPatch": context_patch,
        }


@dataclass(frozen=True)
class PubSubSettings:
    project_id: str
    subscription_id: str
    topic_prefix: str = ""
    outcome_engine_url: str = "http://outcome-engine:8080"

    @classmethod
    def from_env(cls) -> "PubSubSettings":
        project_id = (
            os.environ.get("GOOGLE_CLOUD_PROJECT")
            or os.environ.get("GCP_PROJECT")
            or os.environ.get("GCLOUD_PROJECT")
            or ""
        )
        prefix = os.environ.get("PUBSUB_PREFIX", "")
        subscription = os.environ.get(
            "SWEEPER_SUBSCRIPTION",
            f"{prefix}{NEW_TASK_TOPIC}.{FULFILLER_NAME}",
        )
        return cls(
            project_id=project_id,
            subscription_id=subscription,
            topic_prefix=prefix,
            outcome_engine_url=os.environ.get("OUTCOME_ENGINE_URL", "http://outcome-engine:8080").rstrip("/"),
        )


class GooglePubSubPublisher:
    """Async facade over Google Pub/Sub's future-based publisher client."""

    def __init__(self, project_id: str, topic_prefix: str = "", client: Any = None) -> None:
        if client is None:
            from google.cloud import pubsub_v1

            client = pubsub_v1.PublisherClient()
        self.client = client
        self.project_id = project_id
        self.topic_prefix = topic_prefix

    async def publish(
        self,
        topic: str,
        payload: dict[str, Any],
        attributes: dict[str, str] | None = None,
    ) -> str:
        topic_id = f"{self.topic_prefix}{topic}"
        topic_path = self.client.topic_path(self.project_id, topic_id)
        data = json.dumps(payload, separators=(",", ":")).encode()
        future = self.client.publish(topic_path, data, **(attributes or {}))
        return await asyncio.to_thread(future.result, timeout=30)

    def close(self) -> None:
        stop = getattr(self.client, "stop", None)
        if stop is not None:
            stop()


class OutcomeEngineContextLoader:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def __call__(self, outcome_delivery_id: str) -> dict[str, Any]:
        import httpx

        url = f"{self.base_url}/api/v1/outcome-deliveries/{outcome_delivery_id}/context"
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(url)
            response.raise_for_status()
            context = response.json()
        if not isinstance(context, dict):
            raise ValueError("Outcome Engine returned a non-object delivery context")
        return context


class OutcomeEngineSweepLoader:
    """Resolve a persisted sweep and its context from its product-owned identity."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def __call__(self, sweep_id: str) -> dict[str, Any]:
        import httpx

        state_url = f"{self.base_url}/api/v1/outcome-deliveries/by-source/x-sweep-run/{sweep_id}"
        async with httpx.AsyncClient(timeout=20) as client:
            state_response = await client.get(state_url)
            state_response.raise_for_status()
            state = state_response.json()
            delivery_id = str(state.get("deliveryId", "")) if isinstance(state, dict) else ""
            if not delivery_id:
                raise ValueError("Outcome Engine returned a sweep without a delivery id")
            context_response = await client.get(
                f"{self.base_url}/api/v1/outcome-deliveries/{delivery_id}/context"
            )
            context_response.raise_for_status()
            context = context_response.json()
        if not isinstance(context, dict):
            raise ValueError("Outcome Engine returned a non-object sweep context")
        return {"deliveryId": delivery_id, "sourceId": sweep_id, "context": context}


class PubSubRuntime:
    """Owns the streaming NEW-TASK subscriber for the FastAPI application lifespan."""

    def __init__(
        self,
        settings: PubSubSettings,
        handler: SweepTaskHandler,
        publisher: GooglePubSubPublisher,
        subscriber_client: Any = None,
    ) -> None:
        if subscriber_client is None:
            from google.cloud import pubsub_v1

            subscriber_client = pubsub_v1.SubscriberClient()
        self.settings = settings
        self.handler = handler
        self.publisher = publisher
        self.subscriber_client = subscriber_client
        self.streaming_future: Any = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.started = False
        self.error: str | None = None
        self._lock = threading.Lock()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        from google.cloud import pubsub_v1

        if not self.settings.project_id:
            raise RuntimeError("GOOGLE_CLOUD_PROJECT or GCP_PROJECT is required")
        self.loop = loop
        subscription_path = self.settings.subscription_id
        if not subscription_path.startswith("projects/"):
            subscription_path = self.subscriber_client.subscription_path(
                self.settings.project_id,
                subscription_path,
            )
        self.streaming_future = self.subscriber_client.subscribe(
            subscription_path,
            callback=self._receive,
            flow_control=pubsub_v1.types.FlowControl(max_messages=1),
            await_callbacks_on_shutdown=True,
        )
        self.streaming_future.add_done_callback(self._subscriber_done)
        self.started = True

    def _receive(self, message: Any) -> None:
        if self.loop is None:
            message.nack()
            return
        future = asyncio.run_coroutine_threadsafe(
            self.handler.handle(message.data, dict(message.attributes), message),
            self.loop,
        )
        try:
            future.result()
        except Exception as exc:
            with self._lock:
                self.error = str(exc)
            message.nack()

    def _subscriber_done(self, future: Any) -> None:
        if future.cancelled():
            return
        try:
            future.result()
        except Exception as exc:
            with self._lock:
                self.error = str(exc)

    async def stop(self) -> None:
        if self.streaming_future is not None:
            self.streaming_future.cancel()
            try:
                await asyncio.to_thread(self.streaming_future.result, timeout=5)
            except Exception:
                pass
        close = getattr(self.subscriber_client, "close", None)
        if close is not None:
            close()
        self.publisher.close()
        self.started = False

    def health(self) -> dict[str, Any]:
        return {
            "configured": True,
            "started": self.started,
            "subscription": self.settings.subscription_id,
            "error": self.error,
        }
