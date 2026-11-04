from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from .synthetic import WaveSpec

ALLOWED_TRANSACTION_COUNTS = frozenset({8_000, 10_000, 20_000})
DATASET_GENERATOR_VERSION = "fraud-lab-generator/1.1.0"
DEFAULT_SCENARIO_ID = "multi_new_beneficiary"


def deterministic_seed(dataset_id: uuid.UUID) -> int:
    return int.from_bytes(hashlib.sha256(dataset_id.bytes).digest()[:8], "big") % (2**63)


def dataset_wave_id(dataset_id: uuid.UUID) -> str:
    return f"fraud-lab-wave-dataset-{dataset_id.hex}"


def build_dataset_spec(dataset_id: uuid.UUID, transaction_count: int, seed: int) -> WaveSpec:
    if transaction_count not in ALLOWED_TRANSACTION_COUNTS:
        raise ValueError("unsupported fraud lab dataset size")
    if seed < 0 or seed >= 2**63:
        raise ValueError("fraud lab seed must be a signed 63-bit integer")
    # Fifty chronological payments per customer preserves the existing balanced,
    # customer-group-safe 70/30 discovery/evaluation partitioning at every allowed size.
    customers = transaction_count // 50
    period_start = datetime(2028, 1, 1, tzinfo=UTC) + timedelta(days=seed % 3650)
    return WaveSpec(
        wave_id=dataset_wave_id(dataset_id),
        seed=seed,
        rows=transaction_count,
        customers=customers,
        period_start=period_start,
        pattern=DEFAULT_SCENARIO_ID,
        generator_version=DATASET_GENERATOR_VERSION,
    )
