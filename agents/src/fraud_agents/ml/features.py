from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from fraud_agents.schemas import FlinkEvidence

from . import FEATURE_SCHEMA_VERSION

FEATURE_NAMES = (
    "amount",
    "transactions_1m",
    "transactions_2m",
    "transactions_10m",
    "distinct_merchants_2m",
    "total_amount_2m",
    "mean_amount_2m",
    "merchant_diversity_2m",
)
CLIP_BOUNDS = {
    "amount": (0.0, 100_000.0),
    "transactions_1m": (1.0, 1_000.0),
    "transactions_2m": (1.0, 2_000.0),
    "transactions_10m": (1.0, 10_000.0),
    "distinct_merchants_2m": (1.0, 2_000.0),
    "total_amount_2m": (0.0, 10_000_000.0),
    "mean_amount_2m": (0.0, 100_000.0),
    "merchant_diversity_2m": (0.0, 1.0),
}


@dataclass(frozen=True)
class FeatureVector:
    transaction_id: str
    transaction_timestamp: str
    values: tuple[float, ...]
    provenance: dict[str, Any]


def _finite_clipped(name: str, value: float) -> float:
    if not math.isfinite(value):
        return math.nan
    low, high = CLIP_BOUNDS[name]
    return min(high, max(low, value))


def from_enriched(payload: bytes | str | dict[str, Any]) -> FeatureVector:
    try:
        if isinstance(payload, dict):
            evidence = FlinkEvidence.model_validate(payload)
        else:
            evidence = FlinkEvidence.model_validate_json(payload)
    except (ValidationError, ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid payments.enriched.demo record") from error
    count = float(evidence.transactions_2m)
    raw = {
        "amount": float(evidence.amount),
        "transactions_1m": float(evidence.transactions_1m),
        "transactions_2m": count,
        "transactions_10m": float(evidence.transactions_10m),
        "distinct_merchants_2m": float(evidence.distinct_merchants_2m),
        "total_amount_2m": float(evidence.total_amount_2m),
        "mean_amount_2m": float(evidence.total_amount_2m) / count,
        "merchant_diversity_2m": float(evidence.distinct_merchants_2m) / count,
    }
    return FeatureVector(
        transaction_id=evidence.transaction_id,
        transaction_timestamp=evidence.transaction_timestamp.isoformat(),
        values=tuple(_finite_clipped(name, raw[name]) for name in FEATURE_NAMES),
        provenance={
            "source": "flink_enrichment",
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "event_time": evidence.transaction_timestamp.isoformat(),
            "evidence_source": evidence.evidence_source,
        },
    )
