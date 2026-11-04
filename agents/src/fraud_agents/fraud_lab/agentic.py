"""Deterministic, group-safe source data for the agentic investigation laboratory.

This module deliberately has no database access.  The API layer may expose discovery and
validation records, but must never query ``FINAL_HOLDOUT`` until a candidate is frozen.
"""

import hashlib
import json
import random
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

AGENTIC_DATASET_SCHEMA_VERSION = "fraud-investigation-lab/1.0.0"
AGENTIC_GENERATOR_VERSION = "fraud-investigation-generator/1.0.0"
AGENTIC_WAVE_ID = "fraud-investigation-wave-2027q2-v1"
_NAMESPACE = uuid.UUID("d90e8d03-4870-503f-a9ed-ffc8c7c95e34")
_PARTITIONS = ("DISCOVERY", "VALIDATION", "FINAL_HOLDOUT")


@dataclass(frozen=True)
class AgenticWaveSpec:
    wave_id: str = AGENTIC_WAVE_ID
    seed: int = 20270401
    rows: int = 3_000
    customers: int = 60
    period_start: datetime = datetime(2027, 4, 1, tzinfo=UTC)
    generator_version: str = AGENTIC_GENERATOR_VERSION


@dataclass(frozen=True)
class AgenticTransaction:
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
    baseline_action: str
    features: dict[str, int | float]


DEFAULT_AGENTIC_SPEC = AgenticWaveSpec()


def _id(*parts: object) -> str:
    return str(uuid.uuid5(_NAMESPACE, ":".join(str(part) for part in parts)))


def _partition(customer_index: int) -> str:
    # Whole customer/scenario groups are assigned deterministically: 60/20/20.
    return _PARTITIONS[customer_index % 10 // 6 if customer_index % 10 < 8 else 2]


def generate_agentic_wave(
    spec: AgenticWaveSpec = DEFAULT_AGENTIC_SPEC,
) -> tuple[list[AgenticTransaction], str]:
    if spec.rows % spec.customers:
        raise ValueError("wave rows must divide evenly across customers")
    rng = random.Random(spec.seed)
    per_customer = spec.rows // spec.customers
    rows: list[AgenticTransaction] = []
    for customer_index in range(spec.customers):
        partition = _partition(customer_index)
        customer_id = _id(spec.wave_id, "customer", customer_index)
        scenario_group_id = _id(spec.wave_id, "scenario", partition, customer_index)
        start = spec.period_start + timedelta(hours=customer_index * 2)
        for event_index in range(per_customer):
            event_time = start + timedelta(minutes=event_index * 11 + rng.randrange(4))
            new_beneficiaries = 1
            amount = round(rng.uniform(12, 260), 2)
            fraud = False
            if customer_index % 15 in {2, 7} and 18 <= event_index < 24:
                new_beneficiaries = event_index - 16
                amount = round(rng.uniform(650, 1_650), 2)
                fraud = True
            elif customer_index % 15 in {4, 9} and 18 <= event_index < 24:
                new_beneficiaries = event_index - 16
                amount = round(rng.uniform(450, 1_200), 2)
            velocity = 5 if customer_index % 17 == 0 and event_index in range(10, 16) else 1
            merchants = 4 if velocity == 5 else 1
            action = "BLOCKED" if velocity == 5 and merchants == 4 else "APPROVED"
            rows.append(
                AgenticTransaction(
                    transaction_id=_id(spec.wave_id, "transaction", customer_index, event_index),
                    wave_id=spec.wave_id,
                    partition=partition,
                    scenario_group_id=scenario_group_id,
                    event_time=event_time.isoformat(),
                    customer_id=customer_id,
                    beneficiary_id=_id(spec.wave_id, "beneficiary", customer_index, event_index // 6),
                    merchant_id=_id(spec.wave_id, "merchant", customer_index, event_index % 7),
                    amount=amount,
                    ground_truth_fraud=fraud,
                    baseline_action=action,
                    features={
                        "customer_distinct_new_beneficiary_count": new_beneficiaries,
                        "customer_new_beneficiary_total_gbp": round(amount * new_beneficiaries, 2),
                        "customer_transaction_count": velocity,
                        "customer_distinct_merchant_count": merchants,
                    },
                )
            )
    ordered = sorted(rows, key=lambda row: (row.event_time, row.transaction_id))
    digest = hashlib.sha256(
        "\n".join(json.dumps(asdict(row), sort_keys=True, separators=(",", ":")) for row in ordered).encode()
    ).hexdigest()
    return ordered, digest


def agentic_wave_summary(
    spec: AgenticWaveSpec, rows: list[AgenticTransaction], digest: str
) -> dict[str, object]:
    if len(rows) != spec.rows or {row.partition for row in rows} != set(_PARTITIONS):
        raise ValueError("agentic wave partition integrity failed")
    return {
        "wave_id": spec.wave_id,
        "dataset_schema_version": AGENTIC_DATASET_SCHEMA_VERSION,
        "generator_version": spec.generator_version,
        "seed": spec.seed,
        "period_start": min(row.event_time for row in rows),
        "period_end": max(row.event_time for row in rows),
        "row_count": len(rows),
        "discovery_count": sum(row.partition == "DISCOVERY" for row in rows),
        "validation_count": sum(row.partition == "VALIDATION" for row in rows),
        "final_holdout_count": sum(row.partition == "FINAL_HOLDOUT" for row in rows),
        "content_sha256": digest,
    }
