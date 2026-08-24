"""HTTP integration contract for durable sweep acceptance.

This mirrors Sofom's WebMvc service tests: FastAPI owns the real route, JSON
binding, validation, response, and command construction. Only the external
message publisher is replaced at the service boundary.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

# service.py validates this configuration at import time. The integration test
# never invokes the LLM or browser paths.
os.environ.setdefault("OPENROUTER_API_KEY", "integration-test-not-a-secret")
os.environ.setdefault("SCREENSHOT_DIR", str(Path(tempfile.gettempdir()) / "x-sweeper-agent-tests"))

import service  # noqa: E402


SWEEP_ID = "0198d8f7-96cd-7a42-97a1-b359af601895"
UNFOLLOW_ID = "0198d8f7-96cd-7a42-97a1-b359af601896"
SELECTION_ID = "0198d8f7-96cd-7a42-97a1-b359af601897"


class FakeWebSocket:
    async def close(self) -> None:
        pass


class RecordingPublisher:
    def __init__(self) -> None:
        self.messages: list[tuple[str, dict, dict | None]] = []

    async def publish(self, topic: str, payload: dict, attributes: dict | None = None) -> str:
        self.messages.append((topic, payload, attributes))
        return "message-1"


@pytest.fixture
def publisher() -> RecordingPublisher:
    return RecordingPublisher()


@pytest.fixture
def client(publisher: RecordingPublisher) -> TestClient:
    # FastAPI's app state is the constructor-injection boundary used by the
    # route. It is the Python equivalent of Sofom replacing StreamBridge in a
    # WebMvc slice while retaining the real HTTP/Jackson contract.
    service.app.state.sweep_publisher = publisher
    service.app.state.sweep_loader = lambda sweep_id: {
        "deliveryId": "delivery-1",
        "sourceId": sweep_id,
        "context": {
            "xApi": {"source": {"id": "1478416609", "username": "dlt_alx"}},
            "reviews": [
                {"handle": "@keep", "xUserId": "41", "decision": "KEEP", "reason": "Relevant"},
                {"handle": "@reviewed", "xUserId": "42", "decision": "UNFOLLOW", "reason": "Inactive"},
                {"handle": "@second", "xUserId": "43", "decision": "UNFOLLOW", "reason": "No longer useful"},
            ]
        },
    }
    service.app.state.selection_loader = lambda selection_id: {
        "deliveryId": "selection-delivery-1",
        "sourceId": selection_id,
        "status": "ALL_TASKS_COMPLETED",
        "context": {
            "params": {
                "sweepId": SWEEP_ID,
                "sweepDeliveryId": "delivery-1",
                "sourceXUserId": "1478416609",
                "targets": [
                    {"handle": "@second", "xUserId": "43"},
                    {"handle": "@reviewed", "xUserId": "42"},
                ],
            },
        },
    }
    service.app.state.latest_selection_loader = lambda _sweep_id, _delivery_id: (
        service.app.state.selection_loader(SELECTION_ID)
    )
    service.app.state.action_loader = lambda _action_id: None
    return TestClient(service.app)


def test_accepts_exactly_one_reviewed_unfollow_as_a_product_owned_delivery(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"id": UNFOLLOW_ID, "handle": "@reviewed", "xUserId": "42"},
    )

    assert response.status_code == 202
    assert response.headers["location"] == f"/api/v1/unfollows/{UNFOLLOW_ID}"
    assert response.json() == {"id": UNFOLLOW_ID, "status": "accepted"}

    topic, command, attributes = publisher.messages[-1]
    assert topic == "OUTCOME.DELIVERY.COMMANDS.DELIVER"
    assert attributes is None
    assert command["sourceType"] == "x-sweep-unfollow"
    assert command["sourceId"] == UNFOLLOW_ID
    assert command["outcomeName"] == "sweep-unfollow"
    assert command["outcomeDeliveryContext"] == {
        "origin": "sweeper-agent",
        "params": {
            "sweepId": SWEEP_ID,
            "sweepDeliveryId": "delivery-1",
            "handle": "@reviewed",
            "xUserId": "42",
        },
    }
    assert [step["name"] for step in command["flow"]["steps"]] == ["apply-unfollow"]
    assert command["flow"]["adjacencyList"] == [{"from": "apply-unfollow", "to": "END"}]


def test_persists_one_ordered_reviewed_selection_without_an_x_action(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    targets = [
        {"handle": "@second", "xUserId": "43"},
        {"handle": "@reviewed", "xUserId": "42"},
    ]

    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/selections",
        json={"id": SELECTION_ID, "targets": targets},
    )

    assert response.status_code == 202
    assert response.headers["location"] == f"/api/v1/selections/{SELECTION_ID}"
    assert response.json() == {"id": SELECTION_ID, "status": "accepted"}
    assert len(publisher.messages) == 1

    topic, command, attributes = publisher.messages[0]
    assert topic == "OUTCOME.DELIVERY.COMMANDS.DELIVER"
    assert attributes is None
    assert command["sourceType"] == "x-sweep-selection"
    assert command["sourceId"] == SELECTION_ID
    assert command["outcomeName"] == "sweep-selection"
    assert command["outcomeDeliveryContext"] == {
        "origin": "sweeper-agent",
        "params": {
            "sweepId": SWEEP_ID,
            "sweepDeliveryId": "delivery-1",
            "sourceXUserId": "1478416609",
            "targets": targets,
        },
    }
    assert [step["name"] for step in command["flow"]["steps"]] == ["save-selection"]
    assert command["flow"]["adjacencyList"] == [{"from": "save-selection", "to": "END"}]


def test_accepts_the_durable_selection_as_one_product_owned_x_action(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    targets = [
        {"handle": "@second", "xUserId": "43"},
        {"handle": "@reviewed", "xUserId": "42"},
    ]

    action_id = service.reviewed_action_id("delivery-1")
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"selectionId": SELECTION_ID},
    )

    assert response.status_code == 202
    assert response.headers["location"] == f"/api/v1/unfollows/{action_id}"
    assert response.json() == {"id": action_id, "status": "accepted"}
    assert len(publisher.messages) == 1

    topic, command, attributes = publisher.messages[0]
    assert topic == "OUTCOME.DELIVERY.COMMANDS.DELIVER"
    assert attributes is None
    assert command["sourceType"] == "x-sweep-unfollow"
    assert command["sourceId"] == action_id
    assert command["outcomeName"] == "sweep-unfollow"
    assert command["outcomeDeliveryContext"] == {
        "origin": "sweeper-agent",
        "params": {
            "sweepId": SWEEP_ID,
            "sweepDeliveryId": "delivery-1",
            "selectionId": SELECTION_ID,
            "selectionDeliveryId": "selection-delivery-1",
            "sourceXUserId": "1478416609",
            "targets": targets,
        },
    }
    assert [step["name"] for step in command["flow"]["steps"]] == [
        "apply-unfollow-0001",
        "apply-unfollow-0002",
    ]
    assert command["flow"]["adjacencyList"] == [
        {"from": "apply-unfollow-0001", "to": "apply-unfollow-0002"},
        {"from": "apply-unfollow-0002", "to": "END"},
    ]


def test_an_older_selection_cannot_be_confirmed_after_a_new_version_is_saved(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    service.app.state.latest_selection_loader = lambda _sweep_id, _delivery_id: {
        "deliveryId": "selection-delivery-2",
        "sourceId": UNFOLLOW_ID,
        "status": "ALL_TASKS_COMPLETED",
        "context": {
            "params": {
                "sweepId": SWEEP_ID,
                "sweepDeliveryId": "delivery-1",
            },
        },
    }

    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"selectionId": SELECTION_ID},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "selection has been replaced; review the visible set again"}
    assert publisher.messages == []


def test_repeated_confirmation_returns_the_existing_action_without_redispatch(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    action_id = service.reviewed_action_id("delivery-1")
    service.app.state.action_loader = lambda requested_id: {
        "deliveryId": "action-delivery-1",
        "sourceId": requested_id,
        "status": "ALL_TASKS_COMPLETED",
        "context": {
            "params": {
                "sweepId": SWEEP_ID,
                "sweepDeliveryId": "delivery-1",
                "selectionId": SELECTION_ID,
            },
        },
    }

    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"selectionId": SELECTION_ID},
    )

    assert response.status_code == 202
    assert response.json() == {"id": action_id, "status": "accepted"}
    assert publisher.messages == []


def test_a_second_selection_cannot_replace_the_already_confirmed_action(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    service.app.state.action_loader = lambda requested_id: {
        "deliveryId": "action-delivery-1",
        "sourceId": requested_id,
        "status": "ALL_TASKS_COMPLETED",
        "context": {
            "params": {
                "sweepId": SWEEP_ID,
                "sweepDeliveryId": "delivery-1",
                "selectionId": UNFOLLOW_ID,
            },
        },
    }

    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"selectionId": SELECTION_ID},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "this sweep already has a confirmed selection"}
    assert publisher.messages == []


def test_applying_an_already_unfollowed_profile_returns_a_persisted_noop(monkeypatch) -> None:
    class AlreadyUnfollowedBrowser:
        def __init__(self, _ws, _psid: str) -> None:
            pass

        async def navigate(self, _url: str) -> None:
            pass

        async def unfollow_current_profile(self) -> None:
            raise RuntimeError("profile is not currently followed")

    async def connect_chrome():
        return FakeWebSocket(), "session-1"

    monkeypatch.setattr(service, "_connect_chrome", connect_chrome)
    monkeypatch.setattr(service, "BrowserTools", AlreadyUnfollowedBrowser)

    result = asyncio.run(service.BrowserSweepExecutor().apply_unfollow("@already-gone", "42"))

    assert result == {
        "handle": "@already-gone",
        "xUserId": "42",
        "status": "ALREADY_UNFOLLOWED",
        "detail": "profile is not currently followed",
    }


def test_browser_batch_write_path_is_not_available() -> None:
    with pytest.raises(RuntimeError, match="X_API_REQUIRED_FOR_APPROVED_SET"):
        asyncio.run(service.BrowserSweepExecutor().apply_unfollows([
            {"handle": "@reviewed", "xUserId": "42"},
        ]))


def test_health_reports_the_x_boundary_without_browser_readiness() -> None:
    service.app.state.x_api_adapter = None
    service.app.state.platform_error = "X_API_ADAPTER_URL is required"

    status = asyncio.run(service.health())

    assert "chrome" not in status
    assert status["xApi"] == {
        "configured": False,
        "writeConfigured": False,
        "account": None,
        "error": "X_API_ADAPTER_URL is required",
    }


@pytest.mark.parametrize("handle", ["@keep", "@unknown"])
def test_rejects_a_handle_without_a_persisted_unfollow_decision(
    client: TestClient,
    publisher: RecordingPublisher,
    handle: str,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"id": UNFOLLOW_ID, "handle": handle, "xUserId": "42"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "handle is not a reviewed UNFOLLOW decision"}
    assert publisher.messages == []


def test_rejects_a_stable_id_that_does_not_match_the_persisted_review(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"id": UNFOLLOW_ID, "handle": "@reviewed", "xUserId": "43"},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "target is not the reviewed UNFOLLOW decision"}
    assert publisher.messages == []


def test_accepts_a_dry_run_and_publishes_the_pinned_two_step_flow(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        "/api/v1/sweeps",
        json={"id": SWEEP_ID, "mode": "dry-run", "count": 500},
    )

    assert response.status_code == 202
    assert response.headers["location"] == f"/api/v1/sweeps/{SWEEP_ID}"
    assert response.json() == {"id": SWEEP_ID, "status": "accepted"}

    assert len(publisher.messages) == 1
    topic, command, attributes = publisher.messages[0]
    assert topic == "OUTCOME.DELIVERY.COMMANDS.DELIVER"
    assert attributes is None
    assert command["sourceType"] == "x-sweep-run"
    assert command["sourceId"] == SWEEP_ID
    assert command["prospectId"] is None
    assert command["outcomeName"] == "sweep-run"

    context = command["outcomeDeliveryContext"]
    assert context["origin"] == "sweeper-agent"
    assert context["params"] == {"mode": "dry-run", "count": 500}

    assert command["flow"] == {
        "id": "default",
        "name": "sweep-run-default",
        "definitionVersion": "v1",
        "steps": [
            {
                "id": "generate-candidates",
                "name": "generate-candidates",
                "type": "task",
                "fulfiller": {"id": "sweeper-agent", "name": "sweeper-agent"},
                "requirements": [],
                "continueFlowOnFail": False,
            },
            {
                "id": "review-handles",
                "name": "review-handles",
                "type": "task",
                "fulfiller": {"id": "sweeper-agent", "name": "sweeper-agent"},
                "requirements": [],
                "continueFlowOnFail": False,
            },
        ],
        "adjacencyList": [
            {"from": "generate-candidates", "to": "review-handles"},
            {"from": "review-handles", "to": "END"},
        ],
    }


def test_accepts_auto_unfollow_as_a_review_only_two_step_flow(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        "/api/v1/sweeps",
        json={"id": SWEEP_ID, "mode": "reviewed-auto-unfollow", "count": 3},
    )

    assert response.status_code == 202
    command = publisher.messages[-1][1]
    assert command["outcomeDeliveryContext"]["params"] == {
        "mode": "auto-unfollow",
        "count": 3,
    }
    assert [step["name"] for step in command["flow"]["steps"]] == [
        "generate-candidates",
        "review-handles",
    ]
    assert command["flow"]["adjacencyList"] == [
        {"from": "generate-candidates", "to": "review-handles"},
        {"from": "review-handles", "to": "END"},
    ]


def test_rejects_an_approved_set_without_the_reviewed_x_source_identity(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    service.app.state.sweep_loader = lambda sweep_id: {
        "deliveryId": "delivery-1",
        "sourceId": sweep_id,
        "context": {
            "reviews": [
                {"handle": "@reviewed", "xUserId": "42", "decision": "UNFOLLOW"},
            ],
        },
    }

    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/selections",
        json={"id": SELECTION_ID, "targets": [{"handle": "@reviewed", "xUserId": "42"}]},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "reviewed sweep has no X source identity"}
    assert publisher.messages == []


@pytest.mark.parametrize(
    ("targets", "expected_status"),
    [
        ([], 422),
        ([{"handle": "@reviewed", "xUserId": "42"}, {"handle": "@reviewed", "xUserId": "42"}], 422),
        ([{"handle": "@keep", "xUserId": "41"}], 409),
        ([{"handle": "@unknown", "xUserId": "99"}], 409),
        ([{"handle": "@reviewed", "xUserId": "43"}], 409),
    ],
)
def test_rejects_an_empty_duplicate_or_unreviewed_approved_set_before_publication(
    client: TestClient,
    publisher: RecordingPublisher,
    targets: list[dict],
    expected_status: int,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/selections",
        json={"id": SELECTION_ID, "targets": targets},
    )

    assert response.status_code == expected_status
    assert publisher.messages == []


def test_rejects_raw_targets_at_durable_selection_confirmation(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={
            "selectionId": SELECTION_ID,
            "targets": [{"handle": "@reviewed", "xUserId": "42"}],
        },
    )

    assert response.status_code == 422
    assert publisher.messages == []


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "not-a-uuid", "mode": "dry-run", "count": 30},
        {"id": SWEEP_ID, "mode": "execute", "count": 30},
        {"id": SWEEP_ID, "mode": "dry-run", "count": 0},
        {"id": SWEEP_ID, "mode": "dry-run", "count": 501},
    ],
)
def test_rejects_invalid_or_unsafe_sweep_requests_before_publication(
    client: TestClient,
    publisher: RecordingPublisher,
    payload: dict,
) -> None:
    response = client.post("/api/v1/sweeps", json=payload)

    assert response.status_code == 422
    assert publisher.messages == []


def test_does_not_report_acceptance_when_deliver_publication_fails() -> None:
    class FailingPublisher:
        async def publish(self, topic: str, payload: dict, attributes: dict | None = None) -> str:
            raise RuntimeError("Pub/Sub unavailable")

    service.app.state.sweep_publisher = FailingPublisher()
    response = TestClient(service.app).post(
        "/api/v1/sweeps",
        json={"id": SWEEP_ID, "mode": "dry-run", "count": 30},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "could not accept sweep"}
