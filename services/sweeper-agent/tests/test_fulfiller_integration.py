"""In-process Pub/Sub dynamics test, equivalent to Sofom's stream test binder IT."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from platform_adapter import (  # noqa: E402
    TASK_ACKNOWLEDGED_TOPIC,
    TASK_DONE_TOPIC,
    InMemoryTaskLedger,
    SweepTaskHandler,
)


def new_task(step: str, task_id: str = "task-1") -> bytes:
    return json.dumps(
        {
            "sourceType": "x-sweep-run",
            "sourceId": "0198d8f7-96cd-7a42-97a1-b359af601895",
            "entityType": None,
            "entityId": None,
            "fulfillerName": "sweeper-agent",
            "outcomeDeliveryId": "delivery-1",
            "odTaskId": task_id,
            "outcomeTaskName": step,
            "outcomeName": "sweep-run",
            "requirements": [],
        }
    ).encode()


class RecordingPublisher:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.messages: list[tuple[str, dict]] = []

    async def publish(self, topic: str, payload: dict, attributes: dict | None = None) -> str:
        self.events.append(f"publish:{topic}")
        self.messages.append((topic, payload))
        return f"message-{len(self.messages)}"


class FailOncePublisher(RecordingPublisher):
    def __init__(self, events: list[str], failed_topic: str) -> None:
        super().__init__(events)
        self.failed_topic = failed_topic
        self.has_failed = False

    async def publish(self, topic: str, payload: dict, attributes: dict | None = None) -> str:
        if topic == self.failed_topic and not self.has_failed:
            self.has_failed = True
            self.events.append(f"publish-failed:{topic}")
            raise RuntimeError("Pub/Sub unavailable")
        return await super().publish(topic, payload, attributes)


class RecordingBrokerAck:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.acked = 0
        self.nacked = 0

    def ack(self) -> None:
        self.events.append("broker:ack")
        self.acked += 1

    def nack(self) -> None:
        self.events.append("broker:nack")
        self.nacked += 1


class RecordingExecutor:
    def __init__(self, events: list[str], fail: bool = False) -> None:
        self.events = events
        self.fail = fail
        self.generate_calls: list[int] = []
        self.review_calls: list[tuple[list[str], str]] = []
        self.unfollow_calls: list[str] = []
        self.unfollows_calls: list[list[dict]] = []

    async def generate_candidates(self, count: int) -> list[str]:
        self.events.append("execute:generate")
        self.generate_calls.append(count)
        if self.fail:
            raise RuntimeError("Chrome unavailable")
        return ["@one", "@two"]

    async def review_handles(self, handles: list[str], mode: str) -> list[dict]:
        self.events.append("execute:review")
        self.review_calls.append((handles, mode))
        return [{"handle": handle, "decision": "KEEP"} for handle in handles]

    async def apply_unfollow(self, handle: str) -> dict:
        self.events.append("execute:unfollow")
        self.unfollow_calls.append(handle)
        return {"handle": handle, "status": "APPLIED", "appliedAt": "2026-08-23T12:00:00+00:00"}

    async def apply_unfollows(self, reviews: list[dict]) -> list[dict]:
        self.events.append("execute:auto-unfollow")
        self.unfollows_calls.append(reviews)
        return [
            {"handle": review["handle"], "status": "APPLIED", "appliedAt": "2026-08-23T12:00:00+00:00"}
            for review in reviews
            if review.get("decision") == "UNFOLLOW"
        ]


def run(coro) -> None:
    asyncio.run(coro)


def test_generate_task_publishes_ack_then_context_patch_then_acks_broker() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    loaded: list[str] = []

    async def load_context(delivery_id: str) -> dict:
        loaded.append(delivery_id)
        return {"params": {"count": 2, "mode": "dry-run"}}

    handler = SweepTaskHandler(publisher, executor, load_context)
    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, broker_ack))

    assert loaded == ["delivery-1"]
    assert executor.generate_calls == [2]
    assert [topic for topic, _ in publisher.messages] == [TASK_ACKNOWLEDGED_TOPIC, TASK_DONE_TOPIC]
    assert publisher.messages[0][1]["odTaskId"] == "task-1"
    assert publisher.messages[1][1] == {
        "odTaskId": "task-1",
        "outcomeDeliveryId": "delivery-1",
        "resultCode": "SUCCESS",
        "completionDetail": None,
        "contextPatch": {"candidates": ["@one", "@two"]},
    }
    assert events == [
        f"publish:{TASK_ACKNOWLEDGED_TOPIC}",
        "execute:generate",
        f"publish:{TASK_DONE_TOPIC}",
        "broker:ack",
    ]
    assert broker_ack.acked == 1
    assert broker_ack.nacked == 0


def test_review_task_reads_candidates_from_persisted_delivery_context() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"params": {"mode": "dry-run"}, "candidates": ["@one", "@two"]},
    )

    run(handler.handle(new_task("review-handles"), {"fulfiller-name": "sweeper-agent"}, broker_ack))

    assert executor.review_calls == [(["@one", "@two"], "dry-run")]
    assert publisher.messages[-1][1]["contextPatch"] == {
        "reviews": [
            {"handle": "@one", "decision": "KEEP"},
            {"handle": "@two", "decision": "KEEP"},
        ]
    }


def test_apply_unfollow_task_uses_the_authorized_handle_and_persists_its_result() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"sweepId": "sweep-1", "handle": "@reviewed"},
    )

    run(handler.handle(new_task("apply-unfollow", "task-unfollow"), {}, broker_ack))

    assert executor.unfollow_calls == ["@reviewed"]
    assert publisher.messages[-1][1]["contextPatch"] == {
        "unfollow": {
            "handle": "@reviewed",
            "status": "APPLIED",
            "appliedAt": "2026-08-23T12:00:00+00:00",
        }
    }
    assert broker_ack.acked == 1


def test_auto_unfollow_task_applies_only_persisted_unfollow_reviews() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    reviews = [
        {"handle": "@keep", "decision": "KEEP", "reason": "Relevant"},
        {"handle": "@remove", "decision": "UNFOLLOW", "reason": "Inactive"},
    ]
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"params": {"mode": "auto-unfollow"}, "reviews": reviews},
    )

    run(handler.handle(new_task("apply-unfollows", "task-auto"), {}, broker_ack))

    assert executor.unfollows_calls == [reviews]
    assert publisher.messages[-1][1]["contextPatch"] == {
        "unfollows": [
            {
                "handle": "@remove",
                "status": "APPLIED",
                "appliedAt": "2026-08-23T12:00:00+00:00",
            }
        ]
    }


def test_failed_work_reports_terminal_failure_before_broker_ack() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events, fail=True)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(publisher, executor, lambda _: {"params": {"count": 2}})

    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, broker_ack))

    done = publisher.messages[-1][1]
    assert done["resultCode"] == "FAILURE"
    assert done["completionDetail"] == "Chrome unavailable"
    assert done["contextPatch"] is None
    assert events[-2:] == [f"publish:{TASK_DONE_TOPIC}", "broker:ack"]


def test_redelivery_replays_recorded_done_without_repeating_browser_work() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    ledger = InMemoryTaskLedger()
    handler = SweepTaskHandler(publisher, executor, lambda _: {"params": {"count": 2}}, ledger)

    first_ack = RecordingBrokerAck(events)
    second_ack = RecordingBrokerAck(events)
    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, first_ack))
    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, second_ack))

    assert executor.generate_calls == [2]
    assert [topic for topic, _ in publisher.messages].count(TASK_ACKNOWLEDGED_TOPIC) == 1
    assert [topic for topic, _ in publisher.messages].count(TASK_DONE_TOPIC) == 2
    assert publisher.messages[-1][1] == publisher.messages[-2][1]
    assert first_ack.acked == second_ack.acked == 1


def test_application_routing_guard_acks_a_task_for_another_fulfiller() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(publisher, executor, lambda _: {})

    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "someone-else"}, broker_ack))

    assert publisher.messages == []
    assert executor.generate_calls == []
    assert broker_ack.acked == 1


def test_task_done_publish_failure_leaves_broker_unacked_and_releases_for_redelivery() -> None:
    events: list[str] = []
    publisher = FailOncePublisher(events, TASK_DONE_TOPIC)
    executor = RecordingExecutor(events)
    ledger = InMemoryTaskLedger()
    handler = SweepTaskHandler(publisher, executor, lambda _: {"params": {"count": 2}}, ledger)
    first_ack = RecordingBrokerAck(events)

    try:
        run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, first_ack))
        raise AssertionError("publish failure should escape to the subscriber callback")
    except RuntimeError as exc:
        assert str(exc) == "Pub/Sub unavailable"

    assert first_ack.acked == 0
    assert "task-1" not in ledger.entries

    second_ack = RecordingBrokerAck(events)
    run(handler.handle(new_task("generate-candidates"), {"fulfiller-name": "sweeper-agent"}, second_ack))

    assert executor.generate_calls == [2, 2]
    assert second_ack.acked == 1


def test_malformed_message_is_acked_without_publication_or_work() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(publisher, executor, lambda _: {})

    run(handler.handle(b'{"odTaskId":"missing-required-fields"}', {}, broker_ack))

    assert publisher.messages == []
    assert executor.generate_calls == []
    assert broker_ack.acked == 1
