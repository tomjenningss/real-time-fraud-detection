from __future__ import annotations

import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[2]


class FraudLabDatasetWorkerDeploymentTests(unittest.TestCase):
    def test_worker_is_started_and_observed_by_deployment_lifecycle(self) -> None:
        compose = (REPO_DIR / "compose.yaml").read_text()
        up_script = (REPO_DIR / "deployment" / "up.sh").read_text()
        status_script = (REPO_DIR / "deployment" / "status.sh").read_text()

        self.assertIn("fraud-lab-dataset-worker:", compose)
        self.assertIn("fraud_agents.fraud_lab.dataset_healthcheck", compose)
        self.assertIn("fraud-lab-dataset-worker", up_script)
        self.assertIn("fraud-lab-dataset-worker", status_script)


if __name__ == "__main__":
    unittest.main()
