from __future__ import annotations

import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]


class ControlCenterLifecycleTests(unittest.TestCase):
    def test_control_center_is_in_default_lifecycle(self) -> None:
        makefile = (REPO_DIR / "Makefile").read_text()
        up_script = (REPO_DIR / "deployment" / "up.sh").read_text()
        status_script = (REPO_DIR / "deployment" / "status.sh").read_text()

        self.assertIn("$(COMPOSE) pull control-center", makefile)
        self.assertIn("glaramara-bank control-center", up_script)
        self.assertIn("wait_for_health control-center", up_script)
        self.assertIn('check_health control-center "Confluent Control Center Next-Gen"', status_script)
        self.assertIn("Control Center HTTP readiness: ready", status_script)

    def test_control_center_uses_existing_broker_and_persistent_storage(self) -> None:
        compose = (REPO_DIR / "compose.yaml").read_text()

        self.assertIn("cp-enterprise-control-center-next-gen:2.5.1", compose)
        self.assertIn("CONTROL_CENTER_BOOTSTRAP_SERVERS: kafka:29092", compose)
        self.assertIn("control-center-data:/var/lib/confluent-control-center", compose)
        self.assertNotIn("profiles: [control-center]", compose)

    def test_smoke_probe_is_advisory(self) -> None:
        smoke_test = (REPO_DIR / "deployment" / "smoke_test.py").read_text()

        self.assertIn("Control Center connectivity: reachable", smoke_test)
        self.assertIn("advisory only", smoke_test)
        self.assertIn("except (OSError, urllib.error.URLError)", smoke_test)


if __name__ == "__main__":
    unittest.main()
