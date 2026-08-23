from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

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
    executor = service.ApiSweepExecutor(adapter=object(), write_executor=object())

    reviews = run(executor.review_handles(["@one", "@two"], "dry-run", evidence))

    assert reviewed_profiles == evidence
    assert reviews == [
        {"handle": "@one", "decision": "KEEP", "reason": "Relevant", "xUserId": "42"},
        {"handle": "@two", "decision": "UNFOLLOW", "reason": "Inactive", "xUserId": "43"},
    ]


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
