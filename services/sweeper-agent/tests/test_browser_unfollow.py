from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))
os.environ.setdefault("SCREENSHOT_DIR", str(Path(tempfile.gettempdir()) / "x-sweeper-agent-tests"))

from tools import BrowserTools  # noqa: E402


class ScriptedBrowserTools(BrowserTools):
    def __init__(self, results: list[str]) -> None:
        self.results = iter(results)

    async def _evaluate(self, expression: str):
        return next(self.results)


def run(coro):
    return asyncio.run(coro)


def test_unfollow_requires_following_then_confirms_the_changed_relationship(monkeypatch) -> None:
    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    browser = ScriptedBrowserTools(["following", "clicked", "unfollowed", "not-following"])

    assert run(browser.unfollow_current_profile()) is True


def test_unfollow_refuses_to_click_when_the_profile_is_not_currently_followed() -> None:
    browser = ScriptedBrowserTools(["not-following"])

    with pytest.raises(RuntimeError, match="not currently followed"):
        run(browser.unfollow_current_profile())
