"""Internal client for the Spring Native x-api-adapter service."""

from __future__ import annotations

from typing import Any

import httpx


class XApiAdapterError(RuntimeError):
    pass


class XApiAdapterClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(base_url=self.base_url, timeout=20)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def account(self) -> dict[str, Any]:
        return await self._get("/api/v1/account")

    async def following(self, count: int) -> dict[str, Any]:
        if count < 1 or count > 500:
            raise ValueError("count must be between 1 and 500")

        source: dict[str, Any] | None = None
        evidence: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        cursor: str | None = None
        upstream_requests = 0
        returned_resources = 0
        rate_limit: dict[str, Any] | None = None

        while len(evidence) < count:
            params: dict[str, Any] = {"limit": count - len(evidence)}
            if cursor:
                params["cursor"] = cursor
            page = await self._get("/api/v1/account/following", params=params)
            if source is None and isinstance(page.get("source"), dict):
                source = page["source"]
            upstream_requests += int(page.get("upstreamRequests") or 0)
            returned_resources += int(page.get("returnedResources") or 0)
            if isinstance(page.get("rateLimit"), dict):
                rate_limit = page["rateLimit"]

            for account in page.get("accounts") or []:
                if not isinstance(account, dict):
                    continue
                user_id = str(account.get("id") or "")
                username = str(account.get("username") or "")
                if not user_id or not username or user_id in seen_ids:
                    continue
                seen_ids.add(user_id)
                evidence.append(_candidate_evidence(account))
                if len(evidence) == count:
                    break

            next_cursor = page.get("nextCursor")
            if len(evidence) >= count or not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor

        if len(evidence) != count:
            raise XApiAdapterError(
                f"X API returned {len(evidence)} unique followed accounts; {count} required"
            )

        return {
            "candidates": [item["handle"] for item in evidence],
            "candidateEvidence": evidence,
            "xApi": {
                "source": source or {},
                "returnedResources": returned_resources,
                "upstreamRequests": upstream_requests,
                "rateLimit": rate_limit or {},
            },
        }

    async def posts(self, user_id: str, limit: int = 3) -> dict[str, Any]:
        return await self._get(f"/api/v1/users/{user_id}/posts", params={"limit": limit})

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = await self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            raise XApiAdapterError(f"x-api-adapter unavailable: {exc.__class__.__name__}") from exc
        if not response.is_success:
            detail = _error_detail(response)
            raise XApiAdapterError(f"x-api-adapter HTTP {response.status_code}: {detail}")
        try:
            body = response.json()
        except ValueError as exc:
            raise XApiAdapterError("x-api-adapter returned invalid JSON") from exc
        if not isinstance(body, dict):
            raise XApiAdapterError("x-api-adapter returned a non-object response")
        return body


def _candidate_evidence(account: dict[str, Any]) -> dict[str, Any]:
    username = str(account.get("username") or "")
    metrics = account.get("publicMetrics") if isinstance(account.get("publicMetrics"), dict) else {}
    latest = account.get("latestPost") if isinstance(account.get("latestPost"), dict) else None
    return {
        "xUserId": str(account.get("id") or ""),
        "handle": f"@{username.lstrip('@')}",
        "name": account.get("name"),
        "bio": account.get("description") or "",
        "createdAt": account.get("createdAt"),
        "profileImageUrl": account.get("profileImageUrl"),
        "protected": account.get("protectedAccount"),
        "verified": account.get("verified"),
        "publicMetrics": metrics,
        "latestPost": latest,
    }


def _error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.reason_phrase or "upstream failure"
    if isinstance(body, dict):
        return str(body.get("error") or body.get("detail") or "upstream failure")
    return "upstream failure"
