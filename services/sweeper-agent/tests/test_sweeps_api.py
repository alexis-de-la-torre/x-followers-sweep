"""HTTP integration contract for durable sweep acceptance.

This mirrors Sofom's WebMvc service tests: FastAPI owns the real route, JSON
binding, validation, response, and command construction. Only the external
message publisher is replaced at the service boundary.
"""

from __future__ import annotations

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
            "reviews": [
                {"handle": "@keep", "decision": "KEEP", "reason": "Relevant"},
                {"handle": "@reviewed", "decision": "UNFOLLOW", "reason": "Inactive"},
            ]
        },
    }
    return TestClient(service.app)


def test_accepts_exactly_one_reviewed_unfollow_as_a_product_owned_delivery(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"id": UNFOLLOW_ID, "handle": "@reviewed"},
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
        "sweepId": SWEEP_ID,
        "sweepDeliveryId": "delivery-1",
        "handle": "@reviewed",
    }
    assert [step["name"] for step in command["flow"]["steps"]] == ["apply-unfollow"]
    assert command["flow"]["adjacencyList"] == [{"from": "apply-unfollow", "to": "END"}]


@pytest.mark.parametrize("handle", ["@keep", "@unknown"])
def test_rejects_a_handle_without_a_persisted_unfollow_decision(
    client: TestClient,
    publisher: RecordingPublisher,
    handle: str,
) -> None:
    response = client.post(
        f"/api/v1/sweeps/{SWEEP_ID}/unfollows",
        json={"id": UNFOLLOW_ID, "handle": handle},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "handle is not a reviewed UNFOLLOW decision"}
    assert publisher.messages == []


def test_accepts_a_dry_run_and_publishes_the_pinned_two_step_flow(
    client: TestClient,
    publisher: RecordingPublisher,
) -> None:
    response = client.post(
        "/api/v1/sweeps",
        json={"id": SWEEP_ID, "mode": "dry-run", "count": 30},
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
    assert context["params"] == {"mode": "dry-run", "count": 30}

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


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "not-a-uuid", "mode": "dry-run", "count": 30},
        {"id": SWEEP_ID, "mode": "execute", "count": 30},
        {"id": SWEEP_ID, "mode": "dry-run", "count": 0},
        {"id": SWEEP_ID, "mode": "dry-run", "count": 31},
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
