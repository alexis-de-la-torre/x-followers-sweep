from __future__ import annotations

import importlib.util
import json
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator


SERVICE_DIR = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "chrome_healthcheck", SERVICE_DIR / "chrome-healthcheck.py"
)
assert SPEC and SPEC.loader
HEALTHCHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEALTHCHECK)


class VersionHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        body = json.dumps(self.server.payload).encode("utf-8")
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


@contextmanager
def version_server(payload: object, status: int = 200) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), VersionHandler)
    server.payload = payload
    server.status = status
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/json/version"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class ChromeHealthcheckTest(unittest.TestCase):
    def test_accepts_a_real_browser_version_shape(self) -> None:
        payload = {
            "Browser": "Chrome/151.0",
            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/browser/123",
        }
        with version_server(payload) as url:
            self.assertEqual(0, HEALTHCHECK.main([url]))

    def test_rejects_a_tcp_service_that_is_not_chrome(self) -> None:
        with version_server({"status": "ok"}) as url:
            self.assertEqual(1, HEALTHCHECK.main([url]))

    def test_requires_every_supplied_cdp_path(self) -> None:
        payload = {
            "Browser": "Chrome/151.0",
            "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/browser/123",
        }
        with version_server(payload) as direct_url, version_server(
            {"status": "proxy-only"}
        ) as proxy_url:
            self.assertEqual(1, HEALTHCHECK.main([direct_url, proxy_url]))


if __name__ == "__main__":
    unittest.main()
