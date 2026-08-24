"""Release contract for the SWP-41 Chrome-free staging vertical."""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SERVICE_DIR = Path(__file__).resolve().parents[1]


def load_cleanup_module():
    spec = importlib.util.spec_from_file_location(
        "cleanup_chrome_runtime",
        SERVICE_DIR / "cleanup_chrome_runtime.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_release_neither_builds_nor_renders_chrome() -> None:
    cloudbuild = (REPOSITORY_ROOT / "cloudbuild.yaml").read_text()
    skaffold = (REPOSITORY_ROOT / "skaffold.yaml").read_text()

    assert "build-chrome-vnc" not in cloudbuild
    assert "push-chrome-vnc" not in cloudbuild
    assert "adlt-s26-repo/chrome-vnc" not in cloudbuild
    assert "adlt-s26-repo/chrome-vnc" not in skaffold
    assert "chartPath: k8s/chrome-vnc" not in skaffold
    assert "name: chrome-vnc" not in skaffold


def test_agent_chart_has_no_browser_dependency_and_staging_cleanup_is_bounded() -> None:
    result = subprocess.run(
        [
            "helm",
            "template",
            "sweeper-agent",
            str(REPOSITORY_ROOT / "k8s/sweeper-agent"),
            "--namespace",
            "adlt-staging",
            "--set",
            "runtimeCleanup.enabled=true",
            "--set",
            "image.tag=swp-41-test",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rendered = result.stdout

    assert "BROWSER_WS" not in rendered
    assert "kind: Job" in rendered
    assert 'python3", "/app/cleanup_chrome_runtime.py' in rendered
    assert "chrome-vnc-pvc" not in rendered
    assert "persistentvolumeclaims" not in rendered.lower()


def test_cleanup_targets_runtime_objects_but_never_the_preserved_profile() -> None:
    cleanup = load_cleanup_module()
    resources = {(resource, name) for _, resource, name in cleanup.NAMED_RESOURCES}

    assert ("deployments", "chrome-vnc") in resources
    assert ("statefulsets", "chrome-vnc") in resources
    assert ("services", "chrome-vnc") in resources
    assert ("services", "chrome-vnc-headless") in resources
    assert all(resource != "persistentvolumeclaims" for resource, _ in resources)


def test_agent_entrypoint_does_not_inject_a_browser_endpoint() -> None:
    entrypoint = (SERVICE_DIR / "entrypoint.sh").read_text()
    values = (REPOSITORY_ROOT / "k8s/sweeper-agent/values.yaml").read_text()

    assert "export BROWSER_WS" not in entrypoint
    assert "chrome-vnc:9222" not in entrypoint
    assert "BROWSER_WS" not in values
