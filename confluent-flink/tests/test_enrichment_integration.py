"""Kafka-to-Kafka acceptance tests. Run with RUN_ENRICHMENT_INTEGRATION=1."""
import json
import os
import subprocess
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone


@unittest.skipUnless(os.environ.get("RUN_ENRICHMENT_INTEGRATION") == "1",
                     "set RUN_ENRICHMENT_INTEGRATION=1 against a running enrichment job")
class EnrichmentKafkaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.run_id = "itest-" + uuid.uuid4().hex[:10]
        base = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0) - timedelta(seconds=5)
        cls.events = []

        def add(case, index, second, merchant, amount, tx_suffix=None):
            cls.events.append({
                "transaction_id": f"{cls.run_id}-{case}-{tx_suffix if tx_suffix is not None else index}",
                "user_id": f"{cls.run_id}-{case}", "merchant_id": merchant,
                "amount": amount, "device_id": f"device-{case}",
                "payment_channel": "CARD_PRESENT",
                "event_time": (base + timedelta(seconds=second)).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            })

        for i, amount in enumerate((100, 125, 150)): add("normal", i, i, f"normal-shop-{i}", amount)
        for i in range(6): add("velocity", i, i, "same-shop", 20 + i)
        for i in range(7): add("hopping", i, i, f"hop-shop-{i}", 30 + i)

        # Five logical IDs, with the first event sent twice.
        for i in range(5): add("duplicate", i, i, "dup-shop", 10, tx_suffix=i)
        cls.events.insert(-4, dict(cls.events[-5]))

        # Separate users remain independent despite interleaving.
        for i in range(2):
            add("isolation-a", i, i, "iso-shop", 12)
            add("isolation-b", i, i, "iso-shop", 12)

        # Arrival order 2, 0, 1 must still emit event-time counts 1, 2, 3.
        add("out-of-order", 2, 2, "ooo-shop", 15)
        add("out-of-order", 0, 0, "ooo-shop", 15)
        add("out-of-order", 1, 1, "ooo-shop", 15)

        cls.expected = 3 + 6 + 7 + 5 + 4 + 3
        watermark = {
            "transaction_id": f"{cls.run_id}-watermark", "user_id": "__watermark__",
            "merchant_id": "__none__", "amount": 0, "device_id": "__none__",
            "payment_channel": "CARD_PRESENT",
            "event_time": (base + timedelta(seconds=30)).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
        }
        payload = "\n".join(json.dumps(row, separators=(",", ":")) for row in cls.events + [watermark]) + "\n"
        subprocess.run([
            "podman", "compose", "exec", "-T", "kafka", "kafka-console-producer",
            "--bootstrap-server", "kafka:29092", "--topic", "payments.raw.demo",
        ], input=payload, text=True, check=True)

        deadline = time.time() + 30
        cls.rows = []
        while time.time() < deadline:
            consumed = subprocess.run([
                "podman", "compose", "exec", "-T", "kafka", "kafka-console-consumer",
                "--bootstrap-server", "kafka:29092", "--topic", "payments.enriched.demo",
                "--partition", "0", "--from-beginning", "--timeout-ms", "3000",
            ], text=True, capture_output=True)
            parsed = []
            for line in consumed.stdout.splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("transaction_id", "").startswith(cls.run_id + "-"):
                    parsed.append(row)
            cls.rows = parsed
            if len(parsed) >= cls.expected:
                break
        if len(cls.rows) != cls.expected:
            raise AssertionError(f"expected {cls.expected} unique-run assessments, got {len(cls.rows)}")

    def case(self, name):
        prefix = f"{self.run_id}-{name}-"
        return sorted((r for r in self.rows if r["transaction_id"].startswith(prefix)),
                      key=lambda r: r["transaction_timestamp"])

    def test_three_normal_payments_and_100_to_150_are_normal(self):
        rows = self.case("normal")
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(r["signals"] == [] and r["risk_level"] == "LOW" for r in rows))

    def test_six_rapid_same_merchant_trigger_velocity_only(self):
        rows = self.case("velocity")
        self.assertEqual(rows[-1]["transactions_2m"], 6)
        self.assertEqual(rows[-1]["signals"], ["HIGH_VELOCITY"])

    def test_seven_merchants_trigger_hopping_and_both_signals(self):
        rows = self.case("hopping")
        self.assertEqual(rows[-1]["distinct_merchants_2m"], 7)
        self.assertEqual(rows[-1]["signals"], ["HIGH_VELOCITY", "MERCHANT_HOPPING"])

    def test_duplicate_id_does_not_inflate_counts_or_outputs(self):
        rows = self.case("duplicate")
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[-1]["transactions_2m"], 5)

    def test_users_are_isolated(self):
        self.assertEqual([r["transactions_2m"] for r in self.case("isolation-a")], [1, 2])
        self.assertEqual([r["transactions_2m"] for r in self.case("isolation-b")], [1, 2])

    def test_out_of_order_within_allowance_is_event_time_ordered(self):
        self.assertEqual([r["transactions_2m"] for r in self.case("out-of-order")], [1, 2, 3])


if __name__ == "__main__":
    unittest.main()
