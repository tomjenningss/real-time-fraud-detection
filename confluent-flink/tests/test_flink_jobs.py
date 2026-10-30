import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "flink_jobs.py"
SPEC = importlib.util.spec_from_file_location("flink_jobs", MODULE_PATH)
flink_jobs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(flink_jobs)


class FlinkJobHealthTests(unittest.TestCase):
    def overview(self, slots=2, taskmanagers=1):
        return {"slots-total": slots, "taskmanagers": taskmanagers}

    def test_both_running_are_healthy_even_when_slots_are_occupied(self):
        jobs = {
            "jobs": [
                {"jid": "java-id", "name": flink_jobs.EXPECTED["java"], "state": "RUNNING"},
                {"jid": "sql-id", "name": flink_jobs.EXPECTED["sql"], "state": "RUNNING"},
            ]
        }
        status = flink_jobs.assess(self.overview(), jobs)
        self.assertEqual(status["errors"], [])
        self.assertEqual(status["expected_jobs"]["java"]["running"], 1)

    def test_missing_job_is_a_deployment_plan_not_a_duplicate(self):
        status = flink_jobs.assess(self.overview(), {"jobs": []})
        self.assertEqual(status["errors"], [])
        self.assertEqual(status["expected_jobs"]["java"]["matches"], 0)

    def test_duplicate_is_rejected_and_failed_job_is_missing(self):
        name = flink_jobs.EXPECTED["java"]
        duplicate = flink_jobs.assess(
            self.overview(),
            {"jobs": [{"name": name, "state": "RUNNING"}, {"name": name, "state": "RUNNING"}]},
        )
        self.assertTrue(any("duplicate" in error for error in duplicate["errors"]))
        failed = flink_jobs.assess(
            self.overview(), {"jobs": [{"name": name, "state": "FAILED"}]}
        )
        self.assertEqual(failed["errors"], [])
        self.assertEqual(failed["expected_jobs"]["java"]["running"], 0)

    def test_historical_failed_job_does_not_hide_current_running_job(self):
        name = flink_jobs.EXPECTED["java"]
        status = flink_jobs.assess(
            self.overview(),
            {
                "jobs": [
                    {"jid": "old", "name": name, "state": "FAILED"},
                    {"jid": "current", "name": name, "state": "RUNNING"},
                ]
            },
        )
        self.assertEqual(status["errors"], [])
        self.assertEqual(status["expected_jobs"]["java"]["job_id"], "current")

    def test_registered_capacity_not_unused_capacity_is_checked(self):
        status = flink_jobs.assess(self.overview(slots=1), {"jobs": []})
        self.assertTrue(any("registered slot capacity" in error for error in status["errors"]))


if __name__ == "__main__":
    unittest.main()
