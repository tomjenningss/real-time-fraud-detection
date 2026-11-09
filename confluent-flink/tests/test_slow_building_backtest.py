from __future__ import annotations

import unittest
from datetime import timedelta

from backtest.slow_building import balanced_dataset, evaluate, report


class SlowBuildingBacktestTest(unittest.TestCase):
    def test_balanced_dataset_covers_required_families(self) -> None:
        scenarios = {row.scenario for row in balanced_dataset()}
        self.assertTrue({
            "investment-scam-demo-shape",
            "legitimate-recurring-investment",
            "legitimate-contractor-instalments",
            "legitimate-family-support",
            "legitimate-repeated-payment",
            "legitimate-unusual-escalation",
            "existing-high-velocity",
            "existing-new-beneficiary-high-value",
        }.issubset(scenarios))

    def test_demo_shape_triggers_on_fifth_payment(self) -> None:
        result = report(balanced_dataset())
        self.assertEqual(5, result["earliest_trigger_payment"]["investment-scam-demo-shape"])

    def test_deduplication_is_stable(self) -> None:
        rows = balanced_dataset()
        self.assertEqual(len(evaluate(rows)), len(evaluate(rows + [rows[0]])))

    def test_input_order_does_not_change_event_time_result(self) -> None:
        rows = balanced_dataset()
        forward = evaluate(rows)
        reverse = evaluate(list(reversed(rows)))
        self.assertEqual(forward, reverse)

    def test_thirty_day_boundary_is_inclusive(self) -> None:
        rows = [row for row in balanced_dataset() if row.scenario == "investment-scam-demo-shape"]
        rows[-1] = type(rows[-1])(**{
            **rows[-1].__dict__,
            "event_time": rows[0].event_time + timedelta(days=30),
        })
        final = [row for row in evaluate(rows) if row.transaction_id == rows[-1].transaction_id][0]
        self.assertEqual(5, final.payments_30d)

    def test_evaluation_retains_false_positive_examples(self) -> None:
        result = report(balanced_dataset())
        self.assertGreater(len(result["false_positive_examples"]), 0)
        self.assertGreater(result["metrics"]["additional_fraud_detected"], 0)


if __name__ == "__main__":
    unittest.main()
