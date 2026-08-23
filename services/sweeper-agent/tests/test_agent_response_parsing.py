from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))
os.environ.setdefault("OPENROUTER_API_KEY", "integration-test-not-a-secret")
os.environ.setdefault("SCREENSHOT_DIR", str(Path(tempfile.gettempdir()) / "x-sweeper-agent-tests"))

import service  # noqa: E402
from service import _normalize_review_results, _parse_json_array  # noqa: E402


def test_parses_plain_and_fenced_agent_arrays() -> None:
    assert _parse_json_array('["@one", "@two"]') == ["@one", "@two"]
    assert _parse_json_array('```json\n[{"handle":"@one","decision":"KEEP"}]\n```') == [
        {"handle": "@one", "decision": "KEEP"}
    ]


def test_rejects_non_array_agent_output() -> None:
    with pytest.raises(ValueError, match="JSON array"):
        _parse_json_array('{"handle":"@one"}')


def test_normalizes_a_complete_review_in_requested_order() -> None:
    assert _normalize_review_results(
        [
            {"handle": "two", "decision": "unfollow", "reason": "Inactive account"},
            {"handle": "@One", "decision": "KEEP", "reason": "Relevant recent posts"},
        ],
        ["@One", "@two"],
    ) == [
        {"handle": "@One", "decision": "KEEP", "reason": "Relevant recent posts"},
        {"handle": "@two", "decision": "UNFOLLOW", "reason": "Inactive account"},
    ]


@pytest.mark.parametrize(
    "results, message",
    [
        ([{"handle": "@one", "decision": "KEEP", "reason": ""}], "no reason"),
        ([{"handle": "@other", "decision": "KEEP", "reason": "Fine"}], "unexpected handle"),
        ([{"handle": "@one", "decision": "MAYBE", "reason": "Fine"}], "invalid decision"),
    ],
)
def test_rejects_an_incomplete_or_invalid_review(results: list[dict], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        _normalize_review_results(results, ["@one"])


def test_large_reviews_are_decided_in_ordered_bounded_batches(monkeypatch) -> None:
    handles = [f"@user{i}" for i in range(45)]
    profiles = [{"handle": handle, "bio": f"Profile {i}"} for i, handle in enumerate(handles)]
    batches: list[tuple[list[dict], list[str]]] = []

    async def decide_batch(batch_profiles: list[dict], batch_handles: list[str]) -> list[dict]:
        batches.append((batch_profiles, batch_handles))
        return [
            {"handle": handle, "decision": "KEEP", "reason": "Relevant"}
            for handle in batch_handles
        ]

    monkeypatch.setattr(service, "_decide_review_batch", decide_batch)

    results = asyncio.run(service._decide_reviews(profiles, handles))

    assert [len(batch_handles) for _, batch_handles in batches] == [20, 20, 5]
    assert [result["handle"] for result in results] == handles
    assert [profile for batch_profiles, _ in batches for profile in batch_profiles] == profiles
