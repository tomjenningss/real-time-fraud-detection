from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any

from fraud_agents.events import KafkaPosition, stable_uuid

from . import RISK_EVENT_SCHEMA_VERSION
from .features import from_enriched
from .model import BaselineModel


class ShadowScorer:
    def __init__(self, model: BaselineModel):
        self.model = model

    def score(
        self, raw: bytes, position: KafkaPosition, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        started = time.perf_counter_ns()
        vector = from_enriched(raw)
        probability = self.model.score(vector)
        scored_at = datetime.now(UTC)
        event_id = stable_uuid(
            "baseline-risk", f"{self.model.metadata['model_version']}:{vector.transaction_id}"
        )
        result = {
            "schema_version": RISK_EVENT_SCHEMA_VERSION,
            "event_id": str(event_id),
            "transaction_id": vector.transaction_id,
            "model_version": self.model.metadata["model_version"],
            "feature_schema_version": self.model.metadata["feature_schema_version"],
            "fraud_probability": probability,
            "model_timestamp": scored_at.isoformat(),
            "transaction_timestamp": vector.transaction_timestamp,
            "scoring_latency_ms": (time.perf_counter_ns() - started) / 1_000_000,
            "input_feature_provenance": {
                **vector.provenance,
                "source_reference": f"kafka:{position.topic}:{position.partition}:{position.offset}",
            },
        }
        for name in ("correlation_id", "trace_id"):
            if headers and headers.get(name):
                result[name] = headers[name]
        return result


def serialise(event: dict[str, Any]) -> bytes:
    return json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
