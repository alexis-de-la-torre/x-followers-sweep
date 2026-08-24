#!/usr/bin/env python3
"""Remove the retired Chrome runtime while deliberately preserving its PVC."""

from __future__ import annotations

import json
import os
import ssl
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


SERVICE_ACCOUNT_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")
NAMED_RESOURCES = (
    ("apis/apps/v1", "deployments", "chrome-vnc"),
    ("apis/apps/v1", "statefulsets", "chrome-vnc"),
    ("api/v1", "services", "chrome-vnc"),
    ("api/v1", "services", "chrome-vnc-headless"),
    ("api/v1", "serviceaccounts", "chrome-vnc"),
)
CHROME_SELECTOR = "app.kubernetes.io/name=chrome-vnc"


class KubernetesApi:
    def __init__(self) -> None:
        host = os.environ["KUBERNETES_SERVICE_HOST"]
        port = os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
        self.namespace = (SERVICE_ACCOUNT_DIR / "namespace").read_text().strip()
        self.token = (SERVICE_ACCOUNT_DIR / "token").read_text().strip()
        self.base_url = f"https://{host}:{port}"
        self.ssl_context = ssl.create_default_context(
            cafile=str(SERVICE_ACCOUNT_DIR / "ca.crt"),
        )

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        payload = json.dumps(body).encode() if body is not None else None
        request = Request(
            f"{self.base_url}/{path.lstrip('/')}",
            method=method,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, context=self.ssl_context, timeout=10) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except HTTPError as exc:
            raw = exc.read()
            parsed = json.loads(raw) if raw else {}
            return exc.code, parsed

    def resource_path(self, api: str, resource: str, name: str | None = None) -> str:
        path = f"{api}/namespaces/{quote(self.namespace)}/{resource}"
        return f"{path}/{quote(name)}" if name else path


def delete_named_resources(api: KubernetesApi) -> None:
    delete_options = {"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Foreground"}
    for group, resource, name in NAMED_RESOURCES:
        status, body = api.request(
            "DELETE",
            api.resource_path(group, resource, name),
            delete_options,
        )
        if status not in {200, 202, 404}:
            raise RuntimeError(f"could not delete {resource}/{name}: HTTP {status} {body}")
        print(f"{resource}/{name}: {'absent' if status == 404 else 'deleting'}", flush=True)


def browser_runtime_is_absent(api: KubernetesApi) -> bool:
    for group, resource, name in NAMED_RESOURCES[:-1]:
        status, body = api.request("GET", api.resource_path(group, resource, name))
        if status == 200:
            return False
        if status != 404:
            raise RuntimeError(f"could not inspect {resource}/{name}: HTTP {status} {body}")

    pod_path = api.resource_path("api/v1", "pods")
    status, body = api.request("GET", f"{pod_path}?labelSelector={quote(CHROME_SELECTOR)}")
    if status != 200:
        raise RuntimeError(f"could not inspect Chrome pods: HTTP {status} {body}")
    return not body.get("items")


def main() -> None:
    api = KubernetesApi()
    timeout = int(os.environ.get("RUNTIME_CLEANUP_TIMEOUT_SECONDS", "120"))
    delete_named_resources(api)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if browser_runtime_is_absent(api):
            print(
                "Chrome workloads, pods, services, and service account are absent; "
                "chrome-vnc-pvc was preserved.",
                flush=True,
            )
            return
        time.sleep(2)
    raise TimeoutError(f"Chrome runtime still exists after {timeout} seconds")


if __name__ == "__main__":
    main()
