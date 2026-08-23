#!/usr/bin/env python3
"""Validate that each supplied endpoint is a live Chrome DevTools endpoint."""

from __future__ import annotations

import json
import os
import sys
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


DEFAULT_URL = "http://127.0.0.1:{}/json/version".format(
    os.environ.get("CHROME_CDP_PORT", "9223")
)
TIMEOUT_SECONDS = float(os.environ.get("CHROME_HEALTHCHECK_TIMEOUT_SECONDS", "2"))


def fetch_version(url: str) -> dict[str, Any]:
    with urlopen(url, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        value = json.load(response)

    if not isinstance(value, dict):
        raise RuntimeError(f"{url} did not return a JSON object")
    if not value.get("Browser"):
        raise RuntimeError(f"{url} did not identify a browser")
    websocket_url = value.get("webSocketDebuggerUrl")
    if not isinstance(websocket_url, str) or not websocket_url.startswith("ws"):
        raise RuntimeError(f"{url} did not expose a browser WebSocket URL")
    return value


def main(urls: list[str]) -> int:
    try:
        for url in urls or [DEFAULT_URL]:
            fetch_version(url)
    except (OSError, ValueError, RuntimeError, URLError) as error:
        print(f"Chrome CDP healthcheck failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
