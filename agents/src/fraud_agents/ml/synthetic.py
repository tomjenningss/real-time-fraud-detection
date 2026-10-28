from __future__ import annotations

import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .features import FEATURE_NAMES, from_enriched

SCENARIOS = ("legitimate", "account_takeover", "card_testing", "merchant_hopping")


def generate(path: Path, rows: int = 50_000, seed: int = 20261028) -> dict[str, object]:
    if rows < 100:
        raise ValueError("rows must be at least 100")
    rng = random.Random(seed)
    split_counts = {"train": 0, "validation": 0, "test": 0}
    fraud_count = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output:
        for index in range(rows):
            cohort = index % 10
            split = "train" if cohort < 7 else "validation" if cohort < 9 else "test"
            split_counts[split] += 1
            base_day = {"train": 0, "validation": 70, "test": 90}[split]
            event_time = datetime(2025, 1, 1, tzinfo=UTC) + timedelta(
                days=base_day + (index // 10) % 20, seconds=rng.randrange(86_400)
            )
            latent = rng.random()
            scenario = (
                "account_takeover"
                if latent < 0.008
                else "card_testing"
                if latent < 0.018
                else "merchant_hopping"
                if latent < 0.028
                else "legitimate"
            )
            fraud = scenario != "legitimate"
            # Independent scenario outcome is noisy: some attacks fail and some labels are missed.
            label = int(fraud and rng.random() > 0.12)
            if not fraud and rng.random() < 0.0015:
                label = 1
            fraud_count += label
            typical = rng.lognormvariate(3.5, 0.75)
            amount = typical
            count2 = max(1, int(rng.expovariate(0.9)) + 1)
            count1 = max(1, min(count2, int(count2 * rng.uniform(0.35, 1.0))))
            count10 = count2 + rng.randrange(0, 7)
            merchants = min(count2, max(1, int(rng.expovariate(1.3)) + 1))
            if scenario == "account_takeover":
                amount *= rng.uniform(2.0, 8.0)
                count2 += rng.randrange(0, 5)
            elif scenario == "card_testing":
                amount = rng.uniform(0.5, 18.0)
                count2 += rng.randrange(3, 10)
                count1 = min(count2, count1 + rng.randrange(2, 8))
            elif scenario == "merchant_hopping":
                count2 += rng.randrange(3, 9)
                merchants = rng.randrange(3, count2 + 1)
            count1 = min(count1, count2)
            count10 = max(count10, count2)
            merchants = min(merchants, count2)
            average = max(0.5, typical * rng.uniform(0.65, 1.5))
            total = max(amount, average * count2)
            tx = f"syn-{seed}-{index:08d}"
            signals = []
            if count2 >= 5:
                signals.append("HIGH_VELOCITY")
            if count2 >= 5 and merchants >= 4:
                signals.append("MERCHANT_HOPPING")
            enriched = {
                "assessment_type": "transaction",
                "transaction_id": tx,
                "user_id": f"customer-{split}-{index // 10:07d}",
                "amount": round(amount, 2),
                "merchant_id": f"merchant-{rng.randrange(500):03d}",
                "transaction_timestamp": event_time.isoformat(),
                "transactions_1m": count1,
                "transactions_2m": count2,
                "transactions_10m": count10,
                "distinct_merchants_2m": merchants,
                "total_amount_2m": round(total, 2),
                "signals": signals,
                "signal_ids": [f"txn:{tx}:{s}" for s in signals],
                "risk_level": "HIGH" if signals else "LOW",
                "assessment_timestamp": event_time.isoformat(),
                "evidence_source": "flink",
            }
            vector = from_enriched(enriched)
            record = {
                "split": split,
                "label": label,
                "scenario": scenario,
                "customer_id": enriched["user_id"],
                "event_time": event_time.isoformat(),
                **dict(zip(FEATURE_NAMES, vector.values, strict=True)),
            }
            output.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    return {
        "rows": rows,
        "seed": seed,
        "positive_labels": fraud_count,
        "positive_rate": fraud_count / rows,
        "splits": split_counts,
    }
