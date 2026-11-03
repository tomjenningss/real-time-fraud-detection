from __future__ import annotations

import hashlib
import json
import math
import random
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

from . import DATASET_SCHEMA_VERSION, GENERATOR_VERSION

NAMESPACE = uuid.UUID("9ee0804b-d356-5a29-8f6f-271d5a2a6a0c")
INITIAL_WAVE_ID = "fraud-lab-wave-2026q4-v1"
LEGACY_NEXT_WAVE_ID = "fraud-lab-wave-2027q1-v1"
NEXT_WAVE_ID = "fraud-lab-wave-2027q1-v2"
REPAIR_WAVE_ID = "fraud-lab-wave-2026q4-v2"


@dataclass(frozen=True)
class WaveSpec:
    wave_id: str
    seed: int
    rows: int
    customers: int
    period_start: datetime
    pattern: str
    generator_version: str = GENERATOR_VERSION


@dataclass
class RawTransaction:
    transaction_id: str
    wave_id: str
    partition: str
    scenario_group_id: str
    event_time: datetime
    customer_id: str
    beneficiary_id: str
    merchant_id: str
    amount: float
    ground_truth_fraud: bool


@dataclass(frozen=True)
class LabTransaction:
    transaction_id: str
    wave_id: str
    partition: str
    scenario_group_id: str
    event_time: str
    customer_id: str
    beneficiary_id: str
    merchant_id: str
    amount: float
    ground_truth_fraud: bool
    beneficiary_payment_count_before: int
    transactions_1m: int
    transactions_2m: int
    transactions_10m: int
    distinct_merchants_2m: int
    total_amount_2m: float
    distinct_new_beneficiaries_24h: int
    new_beneficiary_payments_24h: int
    new_beneficiary_total_24h: float
    beneficiary_distinct_customers_24h: int
    baseline_signals: tuple[str, ...]
    baseline_action: str


INITIAL_SPEC = WaveSpec(
    INITIAL_WAVE_ID,
    20261102,
    8_000,
    160,
    datetime(2026, 7, 1, tzinfo=UTC),
    "multi_new_beneficiary",
)
NEXT_SPEC = WaveSpec(
    NEXT_WAVE_ID,
    20270115,
    6_000,
    120,
    datetime(2027, 1, 1, tzinfo=UTC),
    "beneficiary_fan_in",
    "fraud-lab-generator/1.0.2",
)
REPAIR_SPEC = WaveSpec(
    REPAIR_WAVE_ID,
    20261102,
    8_000,
    160,
    datetime(2026, 7, 1, tzinfo=UTC),
    "multi_new_beneficiary",
)


def _id(*parts: object) -> str:
    return str(uuid.uuid5(NAMESPACE, ":".join(str(part) for part in parts)))


def _partition(customer_index: int) -> str:
    return "DISCOVERY" if customer_index % 10 < 7 else "EVALUATION"


def _normal_amount(rng: random.Random) -> float:
    return round(min(2_400.0, max(2.0, rng.lognormvariate(3.65, 0.9))), 2)


def _generate_raw(spec: WaveSpec) -> list[RawTransaction]:
    rng = random.Random(spec.seed)
    per_customer = spec.rows // spec.customers
    if per_customer * spec.customers != spec.rows:
        raise ValueError("wave rows must divide evenly across customers")
    raw: list[RawTransaction] = []
    for customer_index in range(spec.customers):
        partition = _partition(customer_index)
        customer_id = _id(spec.wave_id, "customer", customer_index)
        scenario_group_id = _id(spec.wave_id, "scenario", partition, customer_index)
        stable_beneficiaries = [
            _id(spec.wave_id, "stable-beneficiary", partition, customer_index, index) for index in range(8)
        ]
        event_times = sorted(
            spec.period_start + timedelta(seconds=rng.randrange(90 * 86_400))
            for _ in range(per_customer)
        )

        scenario_bucket = customer_index % 20
        # Every scenario family has complete groups in both partitions. The group ID and
        # customer remain confined to one partition, while behaviour coverage is balanced.
        emerging = spec.pattern == "multi_new_beneficiary" and scenario_bucket in {2, 7, 12, 17}
        lookalike = spec.pattern == "multi_new_beneficiary" and scenario_bucket in {4, 8, 14, 18}
        velocity = scenario_bucket in {5, 9, 15, 19}
        high_value = scenario_bucket in {6, 16}
        fan_in = spec.pattern == "beneficiary_fan_in" and scenario_bucket in {2, 7, 12, 17}
        shared_lookalike = spec.pattern == "beneficiary_fan_in" and scenario_bucket in {4, 8, 14, 18}
        if fan_in:
            scenario_group_id = _id(spec.wave_id, "fan-in-scenario", partition, customer_index // 20)
        elif shared_lookalike:
            scenario_group_id = _id(spec.wave_id, "shared-payee-scenario", partition)

        special_start = 21
        special_times: set[datetime] = set()
        velocity_times: set[datetime] = set()
        fan_times: set[datetime] = set()
        if emerging or lookalike:
            anchor = event_times[special_start]
            for offset in range(5):
                event_times[special_start + offset] = anchor + timedelta(hours=offset * 4, seconds=offset)
                special_times.add(event_times[special_start + offset])
            event_times.sort()
        if velocity:
            anchor = event_times[10]
            for offset in range(6):
                event_times[10 + offset] = anchor + timedelta(seconds=offset * 15)
                velocity_times.add(event_times[10 + offset])
            event_times.sort()
        if fan_in or shared_lookalike:
            cluster = customer_index // 20
            anchor = spec.period_start + timedelta(days=65 if shared_lookalike else 30 + cluster * 4)
            for offset in range(6):
                event_times[18 + offset] = anchor + timedelta(
                    hours=offset * 2,
                    minutes=customer_index % 20,
                )
                fan_times.add(event_times[18 + offset])
            event_times.sort()

        for event_index, event_time in enumerate(event_times):
            beneficiary_id = rng.choice(stable_beneficiaries)
            amount = _normal_amount(rng)
            fraud_probability = 0.0015
            rank = event_times.index(event_time)

            if (emerging or lookalike) and event_time in special_times:
                beneficiary_id = _id(spec.wave_id, "new-beneficiary", customer_index, rank)
                amount = round(rng.uniform(420, 1_850), 2)
                fraud_probability = 0.88 if emerging else 0.004
            elif velocity and event_time in velocity_times:
                beneficiary_id = _id(spec.wave_id, "velocity-beneficiary", customer_index, rank)
                amount = round(rng.uniform(5, 160), 2)
                fraud_probability = 0.78
            elif high_value and rank == 30:
                beneficiary_id = _id(spec.wave_id, "high-value-beneficiary", customer_index)
                amount = round(rng.uniform(5_200, 8_000), 2)
                fraud_probability = 0.82
            elif fan_in and event_time in fan_times:
                cluster = customer_index // 20
                beneficiary_id = _id(spec.wave_id, "fan-in", partition, cluster)
                amount = round(rng.uniform(45, 380), 2)
                fraud_probability = 0.72
            elif shared_lookalike and event_time in fan_times:
                beneficiary_id = _id(spec.wave_id, "legitimate-shared-payee", partition)
                amount = round(rng.uniform(35, 260), 2)
                fraud_probability = 0.002

            merchant_id = (
                beneficiary_id
                if rng.random() < 0.8
                else _id(spec.wave_id, "merchant", rng.randrange(80))
            )
            raw.append(
                RawTransaction(
                    transaction_id=_id(spec.wave_id, "transaction", customer_index, event_index),
                    wave_id=spec.wave_id,
                    partition=partition,
                    scenario_group_id=scenario_group_id,
                    event_time=event_time,
                    customer_id=customer_id,
                    beneficiary_id=beneficiary_id,
                    merchant_id=merchant_id,
                    amount=amount,
                    ground_truth_fraud=rng.random() < fraud_probability,
                )
            )
    return sorted(raw, key=lambda item: (item.event_time, item.transaction_id))


def _recent(
    items: list[RawTransaction], current: RawTransaction, duration: timedelta
) -> list[RawTransaction]:
    cutoff = current.event_time - duration
    return [item for item in items if cutoff <= item.event_time <= current.event_time]


def generate_wave(spec: WaveSpec) -> tuple[list[LabTransaction], str]:
    raw = _generate_raw(spec)
    customer_history: dict[str, list[RawTransaction]] = {}
    beneficiary_history: dict[str, list[RawTransaction]] = {}
    customer_beneficiary_count: dict[tuple[str, str], int] = {}
    enriched: list[LabTransaction] = []
    for current in raw:
        history = customer_history.setdefault(current.customer_id, [])
        prior_count = customer_beneficiary_count.get((current.customer_id, current.beneficiary_id), 0)
        history.append(current)
        beneficiary_events = beneficiary_history.setdefault(current.beneficiary_id, [])
        beneficiary_events.append(current)

        one_minute = _recent(history, current, timedelta(minutes=1))
        two_minutes = _recent(history, current, timedelta(minutes=2))
        ten_minutes = _recent(history, current, timedelta(minutes=10))
        day = _recent(history, current, timedelta(hours=24))
        new_events: list[RawTransaction] = []
        seen_before_window: set[str] = {
            item.beneficiary_id
            for item in history
            if item.event_time < current.event_time - timedelta(hours=24)
        }
        seen_in_window: set[str] = set()
        for item in day:
            if item.beneficiary_id not in seen_before_window and item.beneficiary_id not in seen_in_window:
                new_events.append(item)
            elif item.beneficiary_id not in seen_before_window:
                new_events.append(item)
            seen_in_window.add(item.beneficiary_id)

        signals: list[str] = []
        if len(two_minutes) >= 5:
            signals.append("HIGH_VELOCITY")
        if len(two_minutes) >= 5 and len({item.merchant_id for item in two_minutes}) >= 4:
            signals.append("MERCHANT_HOPPING")
        if prior_count == 0 and current.amount >= 5_000:
            signals.append("NEW_BENEFICIARY_HIGH_VALUE")
        action = "BLOCKED" if {"HIGH_VELOCITY", "MERCHANT_HOPPING"}.issubset(signals) else (
            "CHALLENGED" if signals else "APPROVED"
        )
        beneficiary_day = _recent(beneficiary_events, current, timedelta(hours=24))
        enriched.append(
            LabTransaction(
                transaction_id=current.transaction_id,
                wave_id=current.wave_id,
                partition=current.partition,
                scenario_group_id=current.scenario_group_id,
                event_time=current.event_time.isoformat(),
                customer_id=current.customer_id,
                beneficiary_id=current.beneficiary_id,
                merchant_id=current.merchant_id,
                amount=current.amount,
                ground_truth_fraud=current.ground_truth_fraud,
                beneficiary_payment_count_before=prior_count,
                transactions_1m=len(one_minute),
                transactions_2m=len(two_minutes),
                transactions_10m=len(ten_minutes),
                distinct_merchants_2m=len({item.merchant_id for item in two_minutes}),
                total_amount_2m=round(sum(item.amount for item in two_minutes), 2),
                distinct_new_beneficiaries_24h=len({item.beneficiary_id for item in new_events}),
                new_beneficiary_payments_24h=len(new_events),
                new_beneficiary_total_24h=round(sum(item.amount for item in new_events), 2),
                beneficiary_distinct_customers_24h=len({item.customer_id for item in beneficiary_day}),
                baseline_signals=tuple(signals),
                baseline_action=action,
            )
        )
        customer_beneficiary_count[(current.customer_id, current.beneficiary_id)] = prior_count + 1

    canonical = "\n".join(
        json.dumps(asdict(item), sort_keys=True, separators=(",", ":")) for item in enriched
    ).encode()
    return enriched, hashlib.sha256(canonical).hexdigest()


def wave_summary(spec: WaveSpec, rows: list[LabTransaction], digest: str) -> dict[str, object]:
    if len(rows) != spec.rows or any(not math.isfinite(row.amount) for row in rows):
        raise ValueError("generated wave failed integrity checks")
    return {
        "wave_id": spec.wave_id,
        "dataset_schema_version": DATASET_SCHEMA_VERSION,
        "generator_version": spec.generator_version,
        "seed": spec.seed,
        "period_start": min(row.event_time for row in rows),
        "period_end": max(row.event_time for row in rows),
        "row_count": len(rows),
        "discovery_count": sum(row.partition == "DISCOVERY" for row in rows),
        "evaluation_count": sum(row.partition == "EVALUATION" for row in rows),
        "content_sha256": digest,
    }

