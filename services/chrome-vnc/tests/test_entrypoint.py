from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator


SERVICE_DIR = Path(__file__).resolve().parents[1]
ENTRYPOINT = SERVICE_DIR / "entrypoint.sh"
HEALTHCHECK = SERVICE_DIR / "chrome-healthcheck.py"


class VersionHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        body = json.dumps(
            {
                "Browser": "Chrome/151.0",
                "webSocketDebuggerUrl": "ws://owner/devtools/browser/123",
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


@contextmanager
def live_browser_url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), VersionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/json/version"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def run_bash(script: str, **environment: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(environment)
    command = f"source {shlex.quote(str(ENTRYPOINT))}; {script}"
    return subprocess.run(
        ["bash", "-c", command],
        env=env,
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )


class EntrypointProfileTest(unittest.TestCase):
    def base_environment(self, profile_dir: str) -> dict[str, str]:
        return {
            "CHROME_PROFILE_DIR": profile_dir,
            "CHROME_HEALTHCHECK_PATH": str(HEALTHCHECK),
            "STALE_LOCK_QUIET_SECONDS": "1",
            "STALE_LOCK_WAIT_TIMEOUT_SECONDS": "2",
        }

    def test_recovers_a_dead_same_host_lock(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            result = run_bash(
                """
                acquire_profile_lease
                ln -s "$(hostname)-99999999" "$CHROME_PROFILE_DIR/SingletonLock"
                touch "$CHROME_PROFILE_DIR/SingletonCookie"
                ln -s /tmp/missing "$CHROME_PROFILE_DIR/SingletonSocket"
                recover_stale_singletons
                [[ ! -L "$CHROME_PROFILE_DIR/SingletonLock" ]]
                [[ ! -e "$CHROME_PROFILE_DIR/SingletonCookie" ]]
                [[ ! -L "$CHROME_PROFILE_DIR/SingletonSocket" ]]
                release_profile_lease
                """,
                **self.base_environment(profile_dir),
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)

    def test_preserves_a_live_same_host_lock(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            result = run_bash(
                """
                acquire_profile_lease
                ln -s "$(hostname)-$$" "$CHROME_PROFILE_DIR/SingletonLock"
                if recover_stale_singletons; then exit 70; fi
                [[ -L "$CHROME_PROFILE_DIR/SingletonLock" ]]
                release_profile_lease
                """,
                **self.base_environment(profile_dir),
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)

    def test_recovers_a_foreign_lock_only_after_a_quiet_window(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            environment = self.base_environment(profile_dir)
            environment["PROFILE_OWNER_CDP_URL"] = (
                "http://127.0.0.1:1/json/version"
            )
            result = run_bash(
                """
                acquire_profile_lease
                ln -s old-deployment-pod-41 "$CHROME_PROFILE_DIR/SingletonLock"
                recover_stale_singletons
                [[ ! -L "$CHROME_PROFILE_DIR/SingletonLock" ]]
                release_profile_lease
                """,
                **environment,
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            self.assertIn("recovery may continue", result.stdout)

    def test_preserves_a_foreign_lock_while_its_browser_is_reachable(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir, live_browser_url() as url:
            environment = self.base_environment(profile_dir)
            environment["PROFILE_OWNER_CDP_URL"] = url
            result = run_bash(
                """
                acquire_profile_lease
                ln -s old-deployment-pod-41 "$CHROME_PROFILE_DIR/SingletonLock"
                if recover_stale_singletons; then exit 70; fi
                [[ -L "$CHROME_PROFILE_DIR/SingletonLock" ]]
                release_profile_lease
                """,
                **environment,
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)
            self.assertIn("remained reachable", result.stdout)

    def test_profile_lease_rejects_a_second_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            environment = os.environ.copy()
            environment.update(self.base_environment(profile_dir))
            holder_command = (
                f"source {shlex.quote(str(ENTRYPOINT))}; "
                "acquire_profile_lease; echo acquired; sleep 10 9>&-"
            )
            holder = subprocess.Popen(
                ["bash", "-c", holder_command],
                env=environment,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                assert holder.stdout
                self.assertIn("Acquired exclusive", holder.stdout.readline())
                result = run_bash(
                    "if acquire_profile_lease; then exit 70; fi",
                    **self.base_environment(profile_dir),
                )
                self.assertEqual(0, result.returncode, result.stderr + result.stdout)
                self.assertIn("already held", result.stdout)
            finally:
                os.killpg(holder.pid, signal.SIGTERM)
                try:
                    holder.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(holder.pid, signal.SIGKILL)
                    holder.communicate(timeout=3)

    def test_shutdown_forwards_term_to_chrome_and_waits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "chrome-stopped"
            profile_dir = Path(directory) / "profile"
            result = run_bash(
                """
                acquire_profile_lease
                ln -s "$(hostname)-99999999" "$CHROME_PROFILE_DIR/SingletonLock"
                touch "$CHROME_PROFILE_DIR/SingletonCookie"
                ln -s /tmp/missing "$CHROME_PROFILE_DIR/SingletonSocket"
                fake_chrome() {
                    trap 'printf stopped > "$MARKER"; exit 0' TERM
                    while :; do sleep 0.1; done
                }
                fake_chrome 9>&- &
                CHROME_PID=$!
                sleep 0.2
                shutdown
                [[ -s "$MARKER" ]]
                [[ -z "$CHROME_PID" ]]
                [[ "$PROFILE_LEASE_HELD" == 0 ]]
                [[ ! -L "$CHROME_PROFILE_DIR/SingletonLock" ]]
                [[ ! -e "$CHROME_PROFILE_DIR/SingletonCookie" ]]
                [[ ! -L "$CHROME_PROFILE_DIR/SingletonSocket" ]]
                """,
                MARKER=str(marker),
                CHROME_PROFILE_DIR=str(profile_dir),
                CHROME_SHUTDOWN_TIMEOUT_SECONDS="2",
            )
            self.assertEqual(0, result.returncode, result.stderr + result.stdout)

    def test_startup_fails_when_chrome_never_serves_cdp(self) -> None:
        result = run_bash(
            """
            sleep 10 9>&- &
            CHROME_PID=$!
            if wait_for_chrome_startup; then exit 70; fi
            stop_chrome
            """,
            CHROME_CDP_PORT="1",
            CHROME_HEALTHCHECK_PATH=str(HEALTHCHECK),
            CHROME_STARTUP_TIMEOUT_SECONDS="1",
            CHROME_SHUTDOWN_TIMEOUT_SECONDS="1",
        )
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        self.assertIn("did not expose a valid CDP endpoint", result.stdout)


if __name__ == "__main__":
    unittest.main()
