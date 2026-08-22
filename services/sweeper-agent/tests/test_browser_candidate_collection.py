from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from tools import BrowserTools  # noqa: E402


class CandidateBrowser(BrowserTools):
    def __init__(self, batches: list[list[str]]) -> None:
        self.batches = iter(batches)
        self.navigated: list[str] = []
        self.scrolls: list[int] = []

    async def navigate(self, url: str) -> str:
        self.navigated.append(url)
        return "ok"

    async def _evaluate(self, js: str):
        if "scrollTo" in js:
            return None
        return json.dumps(next(self.batches, []))

    async def scroll(self, pixels: int = 8000) -> str:
        self.scrolls.append(pixels)
        return "ok"

    async def extract_page_text(self) -> str:
        return "Following"


def test_collects_exactly_the_requested_number_of_unique_real_handles() -> None:
    browser = CandidateBrowser([
        ["@One", "@one", "@dlt_alx"],
        ["@one", "@Two", "@Three", "@Four"],
    ])

    handles = asyncio.run(browser.collect_following_handles(3))

    assert handles == ["@One", "@Two", "@Three"]
    assert browser.navigated == ["https://x.com/dlt_alx/following"]
    assert browser.scrolls == [900]
