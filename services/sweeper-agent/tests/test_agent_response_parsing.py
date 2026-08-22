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

from service import _parse_json_array  # noqa: E402


def test_parses_plain_and_fenced_agent_arrays() -> None:
    assert _parse_json_array('["@one", "@two"]') == ["@one", "@two"]
    assert _parse_json_array('```json\n[{"handle":"@one","decision":"KEEP"}]\n```') == [
        {"handle": "@one", "decision": "KEEP"}
    ]


def test_rejects_non_array_agent_output() -> None:
    with pytest.raises(ValueError, match="JSON array"):
        _parse_json_array('{"handle":"@one"}')
