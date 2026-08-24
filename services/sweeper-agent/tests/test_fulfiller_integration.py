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
        self.unfollow_calls: list[tuple[str, str]] = []
        self.unfollows_calls: list[tuple[list[dict], str]] = []

    async def generate_candidates(self, count: int) -> list[str]:
        self.events.append("execute:generate")
        self.generate_calls.append(count)
        if self.fail:
            raise RuntimeError("Chrome unavailable")
        return ["@one", "@two"]

    async def review_handles(
        self,
        handles: list[str],
        mode: str,
        candidate_evidence: list[dict] | None = None,
    ) -> list[dict]:
        self.events.append("execute:review")
        self.review_calls.append((handles, mode))
        return [{"handle": handle, "decision": "KEEP"} for handle in handles]

    async def apply_unfollow(self, handle: str, x_user_id: str) -> dict:
        self.events.append("execute:unfollow")
        self.unfollow_calls.append((handle, x_user_id))
        return {
            "handle": handle,
            "xUserId": x_user_id,
            "status": "APPLIED",
            "transport": "X_API",
            "appliedAt": "2026-08-23T12:00:00+00:00",
        }

    async def apply_unfollows(self, targets: list[dict], source_x_user_id: str) -> list[dict]:
        self.events.append("execute:auto-unfollow")
        self.unfollows_calls.append((targets, source_x_user_id))
        return [
            {
                "handle": target["handle"],
                "xUserId": target["xUserId"],
                "status": "APPLIED",
                "transport": "X_API",
                "appliedAt": "2026-08-23T12:00:00+00:00",
            }
            for target in targets
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


def test_api_candidate_evidence_is_persisted_then_supplied_to_review() -> None:
    evidence = [
        {"xUserId": "42", "handle": "@one", "bio": "Useful", "latestPost": {"id": "9"}},
        {"xUserId": "43", "handle": "@two", "bio": "Also useful", "latestPost": None},
    ]

    class StructuredExecutor(RecordingExecutor):
        def __init__(self, events: list[str]) -> None:
            super().__init__(events)
            self.seen_evidence: list[dict] | None = None

        async def generate_candidates(self, count: int) -> dict:
            self.events.append("execute:generate")
            return {
                "candidates": ["@one", "@two"],
                "candidateEvidence": evidence,
                "xApi": {"returnedResources": 2, "upstreamRequests": 2},
            }

        async def review_handles(
            self,
            handles: list[str],
            mode: str,
            candidate_evidence: list[dict] | None = None,
        ) -> list[dict]:
            self.seen_evidence = candidate_evidence
            return [{"handle": handle, "decision": "KEEP"} for handle in handles]

    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = StructuredExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(publisher, executor, lambda _: {"params": {"count": 2}})

    run(handler.handle(new_task("generate-candidates"), {}, broker_ack))
    patch = publisher.messages[-1][1]["contextPatch"]
    assert patch == {
        "candidates": ["@one", "@two"],
        "candidateEvidence": evidence,
        "xApi": {"returnedResources": 2, "upstreamRequests": 2},
    }

    review_publisher = RecordingPublisher([])
    review_handler = SweepTaskHandler(review_publisher, executor, lambda _: {"params": {}, **patch})
    run(review_handler.handle(new_task("review-handles", "task-review"), {}, RecordingBrokerAck([])))

    assert executor.seen_evidence == evidence


def test_apply_unfollow_task_uses_the_authorized_handle_and_persists_its_result() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {
            "params": {"sweepId": "sweep-1", "handle": "@reviewed", "xUserId": "42"}
        },
    )

    run(handler.handle(new_task("apply-unfollow", "task-unfollow"), {}, broker_ack))

    assert executor.unfollow_calls == [("@reviewed", "42")]
    assert publisher.messages[-1][1]["contextPatch"] == {
        "unfollow": {
            "handle": "@reviewed",
            "xUserId": "42",
            "status": "APPLIED",
            "transport": "X_API",
            "appliedAt": "2026-08-23T12:00:00+00:00",
        }
    }
    assert broker_ack.acked == 1


def test_save_selection_task_persists_the_exact_order_without_executing() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    targets = [
        {"handle": "@second", "xUserId": "43"},
        {"handle": "@remove", "xUserId": "42"},
    ]
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"params": {"targets": targets, "sourceXUserId": "1478416609"}},
    )

    run(handler.handle(new_task("save-selection", "task-selection"), {}, broker_ack))

    assert executor.unfollows_calls == []
    assert executor.unfollow_calls == []
    assert publisher.messages[-1][1]["contextPatch"]["selection"] == {
        "targets": targets,
        "sourceXUserId": "1478416609",
        "status": "SAVED",
    }
    assert broker_ack.acked == 1


def test_each_approved_unfollow_step_persists_visible_progress_before_the_next_target() -> None:
    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = RecordingExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    targets = [
        {"handle": "@second", "xUserId": "43"},
        {"handle": "@remove", "xUserId": "42"},
    ]
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"params": {"targets": targets, "sourceXUserId": "1478416609"}},
    )

    run(handler.handle(new_task("apply-unfollow-0001", "task-auto-1"), {}, broker_ack))

    assert executor.unfollows_calls == [([targets[0]], "1478416609")]
    first_result = publisher.messages[-1][1]["contextPatch"]["unfollowResults"]["43"]
    assert first_result == {
        "handle": "@second",
        "xUserId": "43",
        "status": "APPLIED",
        "transport": "X_API",
        "appliedAt": "2026-08-23T12:00:00+00:00",
        "sequence": 1,
        "completedAt": first_result["completedAt"],
    }
    assert first_result["completedAt"].endswith("+00:00")

    run(handler.handle(new_task("apply-unfollow-0002", "task-auto-2"), {}, broker_ack))

    assert executor.unfollows_calls == [
        ([targets[0]], "1478416609"),
        ([targets[1]], "1478416609"),
    ]
    second_result = publisher.messages[-1][1]["contextPatch"]["unfollowResults"]["42"]
    assert second_result["handle"] == "@remove"
    assert second_result["sequence"] == 2
    assert second_result["completedAt"].endswith("+00:00")


def test_a_persisted_target_failure_completes_its_step_so_the_next_target_can_run() -> None:
    class FailedTargetExecutor(RecordingExecutor):
        async def apply_unfollows(
            self,
            targets: list[dict],
            source_x_user_id: str,
        ) -> list[dict]:
            self.unfollows_calls.append((targets, source_x_user_id))
            target = targets[0]
            return [{
                "handle": target["handle"],
                "xUserId": target["xUserId"],
                "status": "FAILED" if target["xUserId"] == "43" else "APPLIED",
                "transport": "X_API",
                **({"detail": "X write failed"} if target["xUserId"] == "43" else {}),
            }]

    events: list[str] = []
    publisher = RecordingPublisher(events)
    executor = FailedTargetExecutor(events)
    broker_ack = RecordingBrokerAck(events)
    targets = [
        {"handle": "@broken", "xUserId": "43"},
        {"handle": "@next", "xUserId": "44"},
    ]
    handler = SweepTaskHandler(
        publisher,
        executor,
        lambda _: {"params": {"targets": targets, "sourceXUserId": "1478416609"}},
    )

    run(handler.handle(new_task("apply-unfollow-0001", "task-failed-target"), {}, broker_ack))

    done = publisher.messages[-1][1]
    assert done["resultCode"] == "SUCCESS"
    assert done["completionDetail"] is None
    result = done["contextPatch"]["unfollowResults"]["43"]
    assert result["status"] == "FAILED"
    assert result["detail"] == "X write failed"
    assert result["sequence"] == 1

    run(handler.handle(new_task("apply-unfollow-0002", "task-next-target"), {}, broker_ack))

    next_done = publisher.messages[-1][1]
    assert next_done["resultCode"] == "SUCCESS"
    next_result = next_done["contextPatch"]["unfollowResults"]["44"]
    assert next_result["status"] == "APPLIED"
    assert next_result["sequence"] == 2
    assert executor.unfollows_calls == [
        ([targets[0]], "1478416609"),
        ([targets[1]], "1478416609"),
    ]
    assert broker_ack.acked == 2


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
