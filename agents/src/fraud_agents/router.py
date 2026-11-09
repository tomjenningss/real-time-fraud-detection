from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from pydantic import ValidationError

from .database import FraudStore, IdentityConflict
from .events import DlqEvent, KafkaPosition, SourcePosition, build_decision, stable_uuid
from .fast_path_policy import decide
from .schemas import FlinkEvidence


class DecisionRouter:
    def __init__(
        self,
        store: FraudStore,
        *,
        normal_sample_rate: float = 0,
        slow_building_demo_policy_enabled: bool = False,
        dlq_topic: str = "fraud.decisions.dlq",
    ):
        self.store = store
        self.normal_sample_rate = normal_sample_rate
        self.slow_building_demo_policy_enabled = slow_building_demo_policy_enabled
        self.dlq_topic = dlq_topic

    def process(self, raw: bytes, position: KafkaPosition, ingested_at: datetime | None = None) -> bool:
        started = datetime.now(UTC)
        digest = hashlib.sha256(raw).hexdigest()
        source = SourcePosition(
            topic=position.topic,
            partition=position.partition,
            offset=position.offset,
            ingested_at=ingested_at or started,
        )
        try:
            evidence = FlinkEvidence.model_validate_json(raw)
        except (ValidationError, ValueError, UnicodeDecodeError) as error:
            logical_id = stable_uuid(
                "invalid-input", f"{position.topic}:{position.partition}:{position.offset}"
            )
            dlq = DlqEvent(
                event_id=stable_uuid("decision-dlq", str(logical_id)),
                service="router",
                failure_type=type(error).__name__,
                retryable=False,
                source=source,
                sanitised_detail={"reason": "canonical_enriched_event_validation_failed"},
            )
            self.store.record_dlq(
                consumer_name="decision-router",
                logical_event_id=logical_id,
                position=position,
                payload_sha256=digest,
                event_id=dlq.event_id,
                topic=self.dlq_topic,
                key=str(logical_id),
                payload=dlq.model_dump(mode="json"),
            )
            return False
        bucket = int(hashlib.sha256(evidence.transaction_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        result = decide(
            evidence,
            sample_normal=bucket < self.normal_sample_rate,
            slow_building_demo_policy_enabled=self.slow_building_demo_policy_enabled,
        )
        decision, request = build_decision(evidence, result, source, started, datetime.now(UTC))
        try:
            return self.store.record_router_result(
                position=position,
                payload_sha256=digest,
                decision=decision,
                request=request,
                enrichment_evidence=evidence,
            )
        except IdentityConflict as error:
            logical_id = stable_uuid(
                "identity-conflict", f"{position.topic}:{position.partition}:{position.offset}"
            )
            dlq = DlqEvent(
                event_id=stable_uuid("decision-dlq", str(logical_id)),
                service="router",
                failure_type=type(error).__name__,
                retryable=False,
                source=source,
                transaction_id=evidence.transaction_id,
                sanitised_detail={"reason": "transaction_id_reused_with_different_evidence"},
            )
            self.store.record_dlq(
                consumer_name="decision-router",
                logical_event_id=logical_id,
                position=position,
                payload_sha256=digest,
                event_id=dlq.event_id,
                topic=self.dlq_topic,
                key=evidence.transaction_id,
                payload=dlq.model_dump(mode="json"),
            )
            return False
