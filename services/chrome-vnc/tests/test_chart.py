from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CHART = REPOSITORY_ROOT / "k8s" / "chrome-vnc"


@unittest.skipUnless(shutil.which("helm"), "helm is required")
class ChromeChartTest(unittest.TestCase):
    def helm(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["helm", *arguments],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            timeout=20,
            check=False,
        )

    def test_chart_lints(self) -> None:
        result = self.helm("lint", str(CHART))
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)

    def test_chart_renders_one_browser_aware_stateful_owner(self) -> None:
        result = self.helm("template", "chrome-vnc", str(CHART))
        self.assertEqual(0, result.returncode, result.stderr)
        rendered = result.stdout

        self.assertIn("kind: StatefulSet", rendered)
        self.assertIn("serviceName: chrome-vnc-headless", rendered)
        self.assertIn("replicas: 1", rendered)
        self.assertIn("terminationGracePeriodSeconds: 40", rendered)
        self.assertIn("name: PROFILE_OWNER_CDP_URL", rendered)
        self.assertIn("http://chrome-vnc:9222/json/version", rendered)
        self.assertIn("http://127.0.0.1:9223/json/version", rendered)
        self.assertIn("http://127.0.0.1:9222/json/version", rendered)
        self.assertIn("kind: PersistentVolumeClaim", rendered)
        self.assertIn("claimName: chrome-vnc-pvc", rendered)

    def test_chart_scales_the_unpruned_legacy_deployment_to_zero_first(self) -> None:
        result = self.helm("template", "chrome-vnc", str(CHART))
        self.assertEqual(0, result.returncode, result.stderr)
        rendered = result.stdout

        deployment_index = rendered.index("kind: Deployment")
        statefulset_index = rendered.index("kind: StatefulSet")
        self.assertLess(deployment_index, statefulset_index)
        legacy = rendered[deployment_index:statefulset_index]
        self.assertIn("replicas: 0", legacy)
        self.assertIn("type: Recreate", legacy)
        self.assertIn("- /bin/false", legacy)

    def test_chart_rejects_multiple_profile_owners(self) -> None:
        result = self.helm(
            "template", "chrome-vnc", str(CHART), "--set", "replicaCount=2"
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("replicaCount must be 1", result.stderr)


if __name__ == "__main__":
    unittest.main()
