from __future__ import annotations

import argparse
import unittest

from deployment import glaramara_orchestrate_load_test
from deployment.glaramara_load_test import (
    SCENARIOS,
    ApiSession,
    Beneficiary,
    HttpMetrics,
    build_plan,
    latency_summary,
    validate_args,
)


class GlaramaraLoadTestUnitTests(unittest.TestCase):
    def sessions(self) -> list[ApiSession]:
        metrics = HttpMetrics()
        return [
            ApiSession(
                "http://127.0.0.1:13000", f"customer-{index}", "demo=x", metrics, 1, 0
            )
            for index in range(3)
        ]

    def beneficiaries(self, sessions: list[ApiSession]) -> dict[str, list[Beneficiary]]:
        return {
            session.customer_id: [
                Beneficiary(f"{session.customer_id}-paid", "Paid", 1, False),
                *[
                    Beneficiary(
                        f"{session.customer_id}-synthetic-{index}",
                        f"LT token B{index}",
                        0,
                        True,
                    )
                    for index in range(4)
                ],
            ]
            for session in sessions
        }

    def test_plan_is_reproducible_and_uses_valid_distinguishable_requests(self) -> None:
        sessions = self.sessions()
        arguments = {
            "count": 100,
            "profile": "mixed",
            "seed": 20261107,
            "run_id": "smoke-20261107",
            "run_token": "0123456789",
            "sessions": sessions,
            "beneficiaries": self.beneficiaries(sessions),
        }
        first = build_plan(**arguments)
        second = build_plan(**arguments)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 100)
        self.assertTrue({item.scenario for item in first}.issubset(set(SCENARIOS)))
        self.assertEqual(len({item.idempotency_key for item in first}), 100)
        self.assertTrue(
            all(
                item.idempotency_key.startswith("glaramara-load:smoke-20261107:")
                for item in first
            )
        )
        self.assertTrue(
            all(item.reference.startswith("LT-0123456789-") for item in first)
        )
        self.assertTrue(all(len(item.reference) <= 24 for item in first))

    def test_scenario_sequences_preserve_velocity_hopping_and_growth_shape(
        self,
    ) -> None:
        sessions = self.sessions()
        plan = build_plan(
            count=1_000,
            profile="fraud-heavy",
            seed=7,
            run_id="shape",
            run_token="abcdefghij",
            sessions=sessions,
            beneficiaries=self.beneficiaries(sessions),
        )
        velocity = [item for item in plan if item.scenario == "high_velocity"]
        hopping = [item for item in plan if item.scenario == "merchant_hopping"]
        slow = [item for item in plan if item.scenario == "slow_building_investment"]

        self.assertGreaterEqual(len(velocity), 5)
        self.assertEqual(len({item.customer_id for item in velocity}), 1)
        self.assertEqual(len({item.beneficiary_id for item in velocity}), 1)
        self.assertEqual(len({item.customer_id for item in hopping}), 1)
        self.assertEqual(len({item.beneficiary_id for item in hopping[:4]}), 4)
        self.assertEqual(
            [item.amount for item in slow[:5]],
            ["250.00", "500.00", "1000.00", "2000.00", "4000.00"],
        )

    def test_latency_summary_uses_nearest_rank_percentiles(self) -> None:
        result = latency_summary([1, 2, 3, 4, 100])
        self.assertEqual(result["p50_ms"], 3)
        self.assertEqual(result["p95_ms"], 100)
        self.assertEqual(result["max_ms"], 100)

    def test_target_must_be_explicit_loopback_and_stress_requires_approval(
        self,
    ) -> None:
        values = {
            "payment_count": 100,
            "target_rate": 10,
            "run_id": "valid-run",
            "base_url": "http://127.0.0.1:13000",
            "environment": "isolated-local",
            "approve_stress": False,
            "orchestrate_investigations": 0,
            "approve_orchestrate_costs": False,
            "orchestrate_concurrency": 1,
        }
        validate_args(argparse.Namespace(**values))
        with self.assertRaises(SystemExit):
            validate_args(
                argparse.Namespace(**{**values, "base_url": "https://bank.example"})
            )
        with self.assertRaises(SystemExit):
            validate_args(argparse.Namespace(**{**values, "payment_count": 50_000}))

    def test_orchestrate_mode_is_bounded_and_requires_cost_confirmation(self) -> None:
        values = {
            "payment_count": 100,
            "target_rate": 10,
            "run_id": "valid-run",
            "base_url": "http://localhost:13000",
            "environment": "isolated-local",
            "approve_stress": False,
            "orchestrate_investigations": 10,
            "approve_orchestrate_costs": False,
            "orchestrate_concurrency": 1,
        }
        with self.assertRaises(SystemExit):
            validate_args(argparse.Namespace(**values))
        validate_args(
            argparse.Namespace(**{**values, "approve_orchestrate_costs": True})
        )

    def test_separate_orchestrate_mode_is_bounded(self) -> None:
        values = argparse.Namespace(
            environment="isolated-local",
            base_url="http://127.0.0.1:13000",
            source_run_id="smoke-one",
            investigations=10,
            concurrency=1,
            request_timeout=90,
            retry_limit=1,
            approve_orchestrate_costs=True,
        )
        glaramara_orchestrate_load_test.validate(values)
        with self.assertRaises(SystemExit):
            glaramara_orchestrate_load_test.validate(
                argparse.Namespace(**{**vars(values), "investigations": 51})
            )


if __name__ == "__main__":
    unittest.main()
