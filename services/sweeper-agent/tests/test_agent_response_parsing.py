from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))
os.environ.setdefault("OPENROUTER_API_KEY", "integration-test-not-a-secret")
os.environ.setdefault("SCREENSHOT_DIR", str(Path(tempfile.gettempdir()) / "x-sweeper-agent-tests"))

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
