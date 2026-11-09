from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

WINDOW = timedelta(days=30)


@dataclass(frozen=True)
class Thresholds:
    minimum_payments: int = 4
    minimum_cumulative_amount: float = 4_000
    minimum_successive_growth_count: int = 3
    minimum_current_to_first_ratio: float = 4
    minimum_relationship_age_days: float = 21


@dataclass(frozen=True)
class Transaction:
    transaction_id: str
    scenario: str
    customer_id: str
    beneficiary_id: str
    event_time: datetime
    amount: float
    fraud: bool


@dataclass(frozen=True)
class Evaluation:
    transaction_id: str
    scenario: str
    payment_number: int
    fraud: bool
    baseline: bool
    candidate: bool
    payments_30d: int
    cumulative_amount_30d: float
    successive_growth_count: int
    current_to_first_ratio: float
    relationship_age_days: float


def _history(
    scenario: str,
    amounts: list[float],
    *,
    fraud: bool,
    spacing_days: int = 7,
    start: datetime = datetime(2026, 1, 1, 12, tzinfo=UTC),
) -> list[Transaction]:
    return [
        Transaction(
            transaction_id=f"{scenario}-{index + 1}",
            scenario=scenario,
            customer_id=f"customer-{scenario}",
            beneficiary_id=f"beneficiary-{scenario}",
            event_time=start + timedelta(days=index * spacing_days),
            amount=amount,
            fraud=fraud,
        )
        for index, amount in enumerate(amounts)
    ]


def balanced_dataset() -> list[Transaction]:
    """Scenario-balanced held-out fixture; it is intentionally broader than the UI replay."""
    cases = [
        _history("investment-scam-demo-shape", [200, 400, 750, 1_500, 3_000], fraud=True),
        _history("investment-scam-four-step", [300, 600, 1_200, 2_400], fraud=True),
        _history("investment-scam-six-step", [150, 250, 450, 850, 1_600, 2_800], fraud=True),
        _history("investment-scam-variable", [250, 700, 650, 1_500, 3_200], fraud=True),
        _history("investment-scam-low-total", [100, 200, 400, 800, 1_600], fraud=True),
        _history("legitimate-recurring-investment", [600, 600, 600, 600, 600], fraud=False),
        _history("legitimate-contractor-instalments", [800, 1_200, 1_600, 2_000], fraud=False),
        _history("legitimate-family-support", [200, 400, 800, 1_600, 3_200], fraud=False),
        _history("legitimate-repeated-payment", [1_100, 1_100, 1_100, 1_100], fraud=False),
        _history("legitimate-unusual-escalation", [250, 500, 1_000, 2_000, 4_000], fraud=False),
    ]
    # Existing controls are represented independently and must remain baseline-only.
    velocity_start = datetime(2026, 4, 1, 10, tzinfo=UTC)
    cases.append([
        Transaction(
            f"existing-high-velocity-{index + 1}",
            "existing-high-velocity",
            "customer-existing-high-velocity",
            "beneficiary-existing-high-velocity",
            velocity_start + timedelta(seconds=index * 20),
            40,
            True,
        )
        for index in range(6)
    ])
    cases.append(_history("existing-new-beneficiary-high-value", [6_000], fraud=True))
    return [row for case in cases for row in case]


def evaluate(rows: list[Transaction], thresholds: Thresholds = Thresholds()) -> list[Evaluation]:
    ordered = sorted(rows, key=lambda row: (row.event_time, row.transaction_id))
    beneficiary_history: dict[tuple[str, str], list[Transaction]] = {}
    customer_history: dict[str, list[Transaction]] = {}
    seen: set[str] = set()
    results: list[Evaluation] = []
    scenario_payment_number: dict[str, int] = {}
    for current in ordered:
        if current.transaction_id in seen:
            continue
        seen.add(current.transaction_id)
        scenario_payment_number[current.scenario] = scenario_payment_number.get(current.scenario, 0) + 1
        customer = customer_history.setdefault(current.customer_id, [])
        customer.append(current)
        two_minutes = [row for row in customer if current.event_time - row.event_time <= timedelta(minutes=2)]
        relationship_key = (current.customer_id, current.beneficiary_id)
        relationship = beneficiary_history.setdefault(relationship_key, [])
        prior_count = len(relationship)
        relationship.append(current)
        window = [row for row in relationship if current.event_time - row.event_time <= WINDOW]
        growth_count = sum(
            window[index].amount > window[index - 1].amount for index in range(1, len(window))
        )
        ratio = current.amount / window[0].amount if window and window[0].amount else 0
        age_days = (current.event_time - window[0].event_time).total_seconds() / 86_400 if window else 0
        cumulative = round(sum(row.amount for row in window), 2)
        candidate = (
            len(window) >= thresholds.minimum_payments
            and cumulative >= thresholds.minimum_cumulative_amount
            and growth_count >= thresholds.minimum_successive_growth_count
            and ratio >= thresholds.minimum_current_to_first_ratio
            and age_days >= thresholds.minimum_relationship_age_days
        )
        velocity = len(two_minutes) >= 5
        hopping = velocity and len({row.beneficiary_id for row in two_minutes}) >= 4
        high_value_new_beneficiary = prior_count == 0 and current.amount >= 5_000
        results.append(Evaluation(
            current.transaction_id,
            current.scenario,
            scenario_payment_number[current.scenario],
            current.fraud,
            velocity or hopping or high_value_new_beneficiary,
            candidate,
            len(window),
            cumulative,
            growth_count,
            round(ratio, 4),
            round(age_days, 4),
        ))
    return results


def _confusion(rows: list[Evaluation], attribute: str) -> dict[str, float | int]:
    tp = sum(getattr(row, attribute) and row.fraud for row in rows)
    fp = sum(getattr(row, attribute) and not row.fraud for row in rows)
    tn = sum(not getattr(row, attribute) and not row.fraud for row in rows)
    fn = sum(not getattr(row, attribute) and row.fraud for row in rows)
    return {
        "true_positives": tp,
        "false_positives": fp,
        "true_negatives": tn,
        "false_negatives": fn,
        "precision": round(tp / (tp + fp), 4) if tp + fp else 0,
        "recall": round(tp / (tp + fn), 4) if tp + fn else 0,
    }


def report(rows: list[Transaction], thresholds: Thresholds = Thresholds()) -> dict[str, object]:
    started = time.perf_counter_ns()
    evaluated = evaluate(rows, thresholds)
    elapsed_ns = time.perf_counter_ns() - started
    combined_rows = [
        Evaluation(**{**asdict(row), "candidate": row.candidate or row.baseline}) for row in evaluated
    ]
    incremental = [row for row in evaluated if row.candidate and not row.baseline]
    earliest: dict[str, int] = {}
    for row in evaluated:
        if row.candidate and row.scenario not in earliest:
            earliest[row.scenario] = row.payment_number
    return {
        "dataset": {
            "transactions": len(evaluated),
            "scenarios": len({row.scenario for row in evaluated}),
            "fraud_transactions": sum(row.fraud for row in evaluated),
            "legitimate_transactions": sum(not row.fraud for row in evaluated),
        },
        "thresholds": asdict(thresholds),
        "metrics": {
            "baseline": _confusion(evaluated, "baseline"),
            "candidate_only": _confusion(evaluated, "candidate"),
            "combined": _confusion(combined_rows, "candidate"),
            "additional_fraud_detected": sum(row.fraud for row in incremental),
            "additional_legitimate_challenged": sum(not row.fraud for row in incremental),
        },
        "earliest_trigger_payment": earliest,
        "false_positive_examples": [asdict(row) for row in incremental if not row.fraud],
        "additional_fraud_examples": [asdict(row) for row in incremental if row.fraud],
        "event_time_semantics": {
            "window": "inclusive trailing 30 days",
            "ordering": "event_time then transaction_id",
            "deduplication": "transaction_id",
            "operational_limit": "Batch evaluation does not measure Flink watermark or Kafka latency.",
        },
        "local_processing": {
            "elapsed_ms": round(elapsed_ns / 1_000_000, 4),
            "microseconds_per_transaction": round(elapsed_ns / max(1, len(evaluated)) / 1_000, 4),
            "not_end_to_end_latency": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = report(balanced_dataset())
    body = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(body + "\n")
    print(body)


if __name__ == "__main__":
    main()
