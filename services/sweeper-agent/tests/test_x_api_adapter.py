from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import httpx


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))
os.environ.setdefault("OPENROUTER_API_KEY", "integration-test-not-a-secret")
os.environ.setdefault("SCREENSHOT_DIR", str(Path(tempfile.gettempdir()) / "x-sweeper-agent-tests"))

import service  # noqa: E402
from x_api_adapter import XApiAdapterClient, XApiAdapterError  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def test_following_pages_and_maps_durable_candidate_evidence() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        cursor = request.url.params.get("cursor")
        if cursor:
            body = {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "accounts": [account("43", "two", "Second post")],
                "returnedResources": 1,
                "upstreamRequests": 2,
                "rateLimit": {"remaining": 298},
            }
        else:
            body = {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "accounts": [account("42", "one", "First post")],
                "nextCursor": "NEXT-PAGE-123456",
                "returnedResources": 1,
                "upstreamRequests": 2,
                "rateLimit": {"remaining": 299},
            }
        return httpx.Response(200, json=body)

    http = httpx.AsyncClient(base_url="http://x-api-adapter", transport=httpx.MockTransport(handler))
    client = XApiAdapterClient("http://x-api-adapter", http)

    result = run(client.following(2))

    assert result["candidates"] == ["@one", "@two"]
    assert [item["xUserId"] for item in result["candidateEvidence"]] == ["42", "43"]
    assert result["candidateEvidence"][0]["latestPost"]["text"] == "First post"
    assert result["xApi"] == {
        "source": {"id": "1478416609", "username": "dlt_alx"},
        "returnedResources": 2,
        "upstreamRequests": 4,
        "rateLimit": {"remaining": 298},
    }
    assert len(requests) == 2
    assert requests[0].url.params["limit"] == "2"
    assert requests[1].url.params["limit"] == "1"
    assert requests[1].url.params["cursor"] == "NEXT-PAGE-123456"
    run(http.aclose())


def test_api_executor_reviews_persisted_evidence_without_a_browser(monkeypatch) -> None:
    evidence = [
        {"xUserId": "42", "handle": "@one", "bio": "Useful", "latestPost": {"text": "Hello"}},
        {"xUserId": "43", "handle": "@two", "bio": "Quiet", "latestPost": None},
    ]
    reviewed_profiles: list[dict] = []

    async def decide(profiles: list[dict], handles: list[str]) -> list[dict]:
        reviewed_profiles.extend(profiles)
        return [
            {"handle": handles[0], "decision": "KEEP", "reason": "Relevant"},
            {"handle": handles[1], "decision": "UNFOLLOW", "reason": "Inactive"},
        ]

    monkeypatch.setattr(service, "_decide_reviews", decide)
    executor = service.ApiSweepExecutor(adapter=object())

    reviews = run(executor.review_handles(["@one", "@two"], "dry-run", evidence))

    assert reviewed_profiles == evidence
    assert reviews == [
        {"handle": "@one", "decision": "KEEP", "reason": "Relevant", "xUserId": "42"},
        {"handle": "@two", "decision": "UNFOLLOW", "reason": "Inactive", "xUserId": "43"},
    ]


def test_api_executor_applies_one_stable_id_with_fresh_before_and_after_reads() -> None:
    class RelationshipAdapter:
        def __init__(self) -> None:
            self.relationships = [
                {
                    "source": {"id": "1478416609", "username": "dlt_alx"},
                    "target": {"id": "42", "username": "reviewed"},
                    "following": True,
                    "connectionStatus": ["following"],
                },
                {
                    "source": {"id": "1478416609", "username": "dlt_alx"},
                    "target": {"id": "42", "username": "reviewed"},
                    "following": False,
                    "connectionStatus": [],
                },
            ]
            self.unfollowed: list[str] = []

        async def relationship(self, x_user_id: str) -> dict:
            assert x_user_id == "42"
            return self.relationships.pop(0)

        async def unfollow(self, x_user_id: str) -> dict:
            self.unfollowed.append(x_user_id)
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "targetId": x_user_id,
                "following": False,
                "upstreamRequests": 2,
            }

    adapter = RelationshipAdapter()
    executor = service.ApiSweepExecutor(adapter=adapter)

    result = run(executor.apply_unfollow("@reviewed", "42", "1478416609"))

    assert adapter.unfollowed == ["42"]
    assert result["handle"] == "@reviewed"
    assert result["xUserId"] == "42"
    assert result["status"] == "APPLIED"
    assert result["transport"] == "X_API"
    assert result["before"]["following"] is True
    assert result["after"]["following"] is False
    assert result["mutation"]["targetId"] == "42"


def test_api_executor_applies_an_approved_set_sequentially_without_browser_fallback() -> None:
    class OrderedRelationshipAdapter:
        def __init__(self) -> None:
            self.events: list[str] = []
            self.relationship_reads: dict[str, int] = {}

        async def relationship(self, x_user_id: str) -> dict:
            self.events.append(f"relationship:{x_user_id}")
            read = self.relationship_reads.get(x_user_id, 0)
            self.relationship_reads[x_user_id] = read + 1
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "target": {"id": x_user_id, "username": f"target-{x_user_id}"},
                "following": read == 0,
                "connectionStatus": ["following"] if read == 0 else [],
            }

        async def unfollow(self, x_user_id: str) -> dict:
            self.events.append(f"unfollow:{x_user_id}")
            if x_user_id == "43":
                raise RuntimeError("X write failed")
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "targetId": x_user_id,
                "following": False,
            }

    adapter = OrderedRelationshipAdapter()
    executor = service.ApiSweepExecutor(adapter=adapter)
    targets = [
        {"handle": "@first", "xUserId": "42"},
        {"handle": "@broken", "xUserId": "43"},
        {"handle": "@last", "xUserId": "44"},
    ]

    results = run(executor.apply_unfollows(targets, "1478416609"))

    assert adapter.events == [
        "relationship:42", "unfollow:42", "relationship:42",
        "relationship:43", "unfollow:43",
        "relationship:44", "unfollow:44", "relationship:44",
    ]
    assert [(result["handle"], result["xUserId"], result["status"]) for result in results] == [
        ("@target-42", "42", "APPLIED"),
        ("@target-43", "43", "FAILED"),
        ("@target-44", "44", "APPLIED"),
    ]
    assert [result["reviewedHandle"] for result in results] == [
        "@first", "@broken", "@last",
    ]
    assert [result["sequence"] for result in results] == [1, 2, 3]
    assert all(result["completedAt"].endswith("+00:00") for result in results)
    assert results[0]["transport"] == results[2]["transport"] == "X_API"
    assert results[1]["detail"] == "X write failed"


def test_api_executor_persists_an_already_unfollowed_target_as_a_terminal_noop() -> None:
    class AlreadyGoneAdapter:
        async def relationship(self, x_user_id: str) -> dict:
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "target": {"id": x_user_id, "username": "gone"},
                "following": False,
                "connectionStatus": [],
            }

        async def unfollow(self, _x_user_id: str) -> dict:
            raise AssertionError("an already-unfollowed target must not be mutated")

    executor = service.ApiSweepExecutor(adapter=AlreadyGoneAdapter())

    result = run(executor.apply_unfollow("@gone", "42", "1478416609"))

    assert result["status"] == "ALREADY_UNFOLLOWED"
    assert result["transport"] == "X_API"
    assert result["before"]["following"] is False


def test_api_executor_refuses_to_write_from_a_different_authenticated_source() -> None:
    class DifferentSourceAdapter:
        def __init__(self) -> None:
            self.mutations: list[str] = []

        async def relationship(self, x_user_id: str) -> dict:
            return {
                "source": {"id": "999", "username": "someone_else"},
                "target": {"id": x_user_id, "username": "reviewed"},
                "following": True,
                "connectionStatus": ["following"],
            }

        async def unfollow(self, x_user_id: str) -> dict:
            self.mutations.append(x_user_id)
            return {"source": {"id": "999"}, "targetId": x_user_id, "following": False}

    adapter = DifferentSourceAdapter()
    executor = service.ApiSweepExecutor(adapter=adapter)

    results = run(executor.apply_unfollows(
        [{"handle": "@reviewed", "xUserId": "42"}],
        "1478416609",
    ))

    assert adapter.mutations == []
    assert len(results) == 1
    assert results[0]["handle"] == "@reviewed"
    assert results[0]["xUserId"] == "42"
    assert results[0]["sequence"] == 1
    assert results[0]["status"] == "FAILED"
    assert results[0]["transport"] == "X_API"
    assert results[0]["detail"] == "X_SOURCE_ACCOUNT_MISMATCH"
    assert results[0]["before"]["source"]["id"] == "999"
    assert results[0]["startedAt"].endswith("+00:00")
    assert results[0]["completedAt"].endswith("+00:00")


def test_api_executor_retains_current_handle_and_available_evidence_when_after_read_fails() -> None:
    class FailingAfterReadAdapter:
        def __init__(self) -> None:
            self.relationship_reads = 0

        async def relationship(self, x_user_id: str) -> dict:
            self.relationship_reads += 1
            if self.relationship_reads == 2:
                raise RuntimeError("after relationship read failed")
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "target": {"id": x_user_id, "username": "current_name"},
                "following": True,
                "connectionStatus": ["following"],
            }

        async def unfollow(self, x_user_id: str) -> dict:
            return {
                "source": {"id": "1478416609", "username": "dlt_alx"},
                "targetId": x_user_id,
                "following": False,
            }

    executor = service.ApiSweepExecutor(adapter=FailingAfterReadAdapter())

    results = run(executor.apply_unfollows(
        [{"handle": "@review_handle", "xUserId": "42"}],
        "1478416609",
    ))

    assert len(results) == 1
    result = results[0]
    assert result["status"] == "FAILED"
    assert result["handle"] == "@current_name"
    assert result["reviewedHandle"] == "@review_handle"
    assert result["before"]["following"] is True
    assert result["mutation"]["following"] is False
    assert result["detail"] == "after relationship read failed"
    assert result["sequence"] == 1
    assert result["completedAt"].endswith("+00:00")


def test_adapter_client_uses_stable_id_for_relationship_lookup_and_delete() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "DELETE":
            return httpx.Response(200, json={"targetId": "42", "following": False})
        return httpx.Response(200, json={
            "target": {"id": "42", "username": "reviewed"},
            "following": True,
        })

    http = httpx.AsyncClient(base_url="http://x-api-adapter", transport=httpx.MockTransport(handler))
    client = XApiAdapterClient("http://x-api-adapter", http)

    before = run(client.relationship("42"))
    applied = run(client.unfollow("42"))

    assert before["following"] is True
    assert applied == {"targetId": "42", "following": False}
    assert [(request.method, request.url.path) for request in requests] == [
        ("GET", "/api/v1/account/following/42"),
        ("DELETE", "/api/v1/account/following/42"),
    ]
    run(http.aclose())


def test_adapter_error_surfaces_category_without_raw_secret_like_body() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "X_CREDITS_REQUIRED", "detail": "private upstream text"})

    http = httpx.AsyncClient(base_url="http://x-api-adapter", transport=httpx.MockTransport(handler))
    client = XApiAdapterClient("http://x-api-adapter", http)

    try:
        run(client.account())
        raise AssertionError("expected adapter error")
    except XApiAdapterError as exc:
        assert str(exc) == "x-api-adapter HTTP 402: X_CREDITS_REQUIRED"
        assert "private upstream text" not in str(exc)
    finally:
        run(http.aclose())


def test_account_probe_retries_adapter_startup_race(monkeypatch) -> None:
    class StartsAfterTwoAttempts:
        def __init__(self) -> None:
            self.attempts = 0

        async def account(self) -> dict:
            self.attempts += 1
            if self.attempts < 3:
                raise XApiAdapterError("x-api-adapter unavailable: ConnectError")
            return {"id": "1478416609", "username": "dlt_alx"}

    async def no_wait(_seconds: float) -> None:
        return None

    monkeypatch.setattr(service.asyncio, "sleep", no_wait)
    adapter = StartsAfterTwoAttempts()
    app = SimpleNamespace(state=SimpleNamespace())

    run(service._load_x_account(app, adapter))

    assert adapter.attempts == 3
    assert app.state.x_account == {"id": "1478416609", "username": "dlt_alx"}
    assert app.state.x_api_error is None


def account(user_id: str, username: str, post: str) -> dict:
    return {
        "id": user_id,
        "username": username,
        "name": username.title(),
        "description": "Profile bio",
        "createdAt": "2020-01-01T00:00:00Z",
        "profileImageUrl": "https://img.example/avatar.jpg",
        "protectedAccount": False,
        "verified": False,
        "publicMetrics": {"followersCount": 12, "followingCount": 34, "postCount": 56},
        "latestPost": {"id": f"post-{user_id}", "text": post, "createdAt": "2026-08-22T00:00:00Z"},
    }
