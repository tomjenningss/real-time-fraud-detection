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


@unittest.skipUnless(os.environ.get("RUN_SLOW_BUILDING_INTEGRATION") == "1",
                     "set RUN_SLOW_BUILDING_INTEGRATION=1 against the isolated replay job")
class SlowBuildingReplayKafkaTests(unittest.TestCase):
    RAW_TOPIC = "payments.raw.slow-building-replay"
    ENRICHED_TOPIC = "payments.enriched.slow-building-replay"

    @classmethod
    def setUpClass(cls):
        first = cls.publish_run("replay-a")
        second = cls.publish_run("replay-b")
        cls.runs = {"replay-a": first, "replay-b": second}

    @classmethod
    def consume(cls):
        consumed = subprocess.run([
            "podman", "compose", "exec", "-T", "kafka", "kafka-console-consumer",
            "--bootstrap-server", "kafka:29092", "--topic", cls.ENRICHED_TOPIC,
            "--partition", "0", "--from-beginning", "--timeout-ms", "3000",
        ], text=True, capture_output=True)
        rows = []
        for line in consumed.stdout.splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows

    @classmethod
    def publish_run(cls, label):
        existing = cls.consume()
        latest = max(
            (datetime.fromisoformat(row["transaction_timestamp"].replace("Z", "+00:00"))
             for row in existing),
            default=datetime.now(timezone.utc) - timedelta(days=28, seconds=5),
        )
        start = max(
            datetime.now(timezone.utc) - timedelta(days=28),
            latest + timedelta(seconds=3, milliseconds=5),
        ).replace(tzinfo=None)
        run_id = "slow-itest-" + uuid.uuid4().hex[:10] + "-" + label
        amounts = (200, 400, 750, 1_500, 3_000)
        events = []
        for index, amount in enumerate(amounts):
            events.append({
                "transaction_id": f"{run_id}-{index + 1}",
                "user_id": run_id,
                "merchant_id": "beneficiary:slow-itest",
                "beneficiary_id": "slow-itest-beneficiary",
                "beneficiary_payment_count": index,
                "amount": amount,
                "device_id": "slow-itest-device",
                "payment_channel": "OTHER",
                "event_time": (start + timedelta(days=7 * index)).strftime(
                    "%Y-%m-%d %H:%M:%S.%f")[:-3],
            })
        watermark = {
            "transaction_id": f"{run_id}-watermark", "user_id": "__watermark__",
            "merchant_id": "__none__", "amount": 0, "device_id": "__none__",
            "payment_channel": "OTHER",
            "event_time": (start + timedelta(days=28, seconds=3)).strftime(
                "%Y-%m-%d %H:%M:%S.%f")[:-3],
        }
        payload = "\n".join(json.dumps(row, separators=(",", ":")) for row in events + [watermark]) + "\n"
        subprocess.run([
            "podman", "compose", "exec", "-T", "kafka", "kafka-console-producer",
            "--bootstrap-server", "kafka:29092", "--topic", cls.RAW_TOPIC,
        ], input=payload, text=True, check=True)
        deadline = time.time() + 30
        rows = []
        while time.time() < deadline:
            rows = sorted(
                (row for row in cls.consume() if row.get("transaction_id", "").startswith(run_id + "-")),
                key=lambda row: row["transaction_timestamp"],
            )
            if len(rows) == 5:
                break
        if len(rows) != 5:
            raise AssertionError(f"expected five assessments for {run_id}, got {len(rows)}")
        return rows

    def test_fifth_payment_emits_exact_slow_building_evidence(self):
        rows = self.runs["replay-a"]
        self.assertTrue(all("SLOW_BUILDING_BENEFICIARY_RISK" not in row["signals"] for row in rows[:4]))
        self.assertIn("SLOW_BUILDING_BENEFICIARY_RISK", rows[4]["signals"])
        evidence = rows[4]["slow_building_beneficiary_evidence"]
        self.assertEqual(evidence["payments_30d"], 5)
        self.assertEqual(evidence["cumulative_amount_30d"], 5_850)
        self.assertEqual(evidence["successive_growth_count"], 4)
        self.assertEqual(evidence["current_to_first_amount_ratio"], 15)
        self.assertEqual(evidence["observed_relationship_age_days"], 28)

    def test_repeated_replay_uses_fresh_state(self):
        rows = self.runs["replay-b"]
        self.assertEqual([row["slow_building_beneficiary_evidence"]["payments_30d"] for row in rows],
                         [1, 2, 3, 4, 5])
        self.assertEqual(rows[-1]["signals"], ["SLOW_BUILDING_BENEFICIARY_RISK"])


if __name__ == "__main__":
    unittest.main()
