from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import Field

from .fast_path_policy import FastPathResult
from .schemas import FlinkEvidence, StrictModel, Verdict

SCHEMA_VERSION = "1.0.0"


@dataclass(frozen=True)
class KafkaPosition:
    topic: str
    partition: int
    offset: int


def utc_now() -> datetime:
    return datetime.now(UTC)


def stable_uuid(kind: str, identity: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"fraud-demo:{kind}:{identity}")


def evidence_sha256(evidence: FlinkEvidence) -> str:
    body = json.dumps(evidence.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


class SourcePosition(StrictModel):
    topic: str
    partition: int = Field(ge=0)
    offset: int = Field(ge=0)
    ingested_at: datetime = Field(default_factory=utc_now)


class PaymentDecisionEvent(StrictModel):
    schema_version: Literal["1.0.0"] = SCHEMA_VERSION
    event_id: UUID
    decision_id: UUID
    transaction_id: str
    correlation_id: UUID
    payment_verdict: Verdict
    decision_source: Literal["deterministic_fast_path"] = "deterministic_fast_path"
    policy_version: str
    triggered_rule_ids: list[str]
    investigation_required: bool
    investigation_reason: str | None
    source_evidence_references: list[str]
    evidence_sha256: str
    transaction_timestamp: datetime
    ingested_at: datetime
    decided_at: datetime
    decision_processing_latency_ms: float = Field(ge=0)
    ingestion_to_decision_ms: float = Field(ge=0)


class InvestigationRequestEvent(StrictModel):
    schema_version: Literal["1.0.0"] = SCHEMA_VERSION
    event_id: UUID
    investigation_id: UUID
    decision_id: UUID
    transaction_id: str
    correlation_id: UUID
    original_payment_verdict: Verdict
    routing_reason: str
    fast_path_policy_version: str
    evidence: FlinkEvidence
    source_evidence_references: list[str]
    requested_at: datetime


class InvestigationCompletedEvent(StrictModel):
    schema_version: Literal["1.0.0"] = SCHEMA_VERSION
    event_id: UUID
    investigation_id: UUID
    decision_id: UUID
    transaction_id: str
    correlation_id: UUID
    original_payment_verdict: Verdict
    recommended_action: Verdict
    investigation_policy_version: str
    triggered_rule_ids: list[str]
    reason: str
    source_evidence_references: list[str]
    model_configuration: dict[str, str]
    audit_reference: str
    mode: Literal["dry-run", "live"]
    completed_at: datetime


class DlqEvent(StrictModel):
    schema_version: Literal["1.0.0"] = SCHEMA_VERSION
    event_id: UUID
    service: Literal["router", "investigation_worker"]
    failure_type: str
    retryable: bool
    source: SourcePosition
    transaction_id: str | None = None
    correlation_id: UUID | None = None
    sanitised_detail: dict[str, Any] = Field(default_factory=dict)
    failed_at: datetime = Field(default_factory=utc_now)


def build_decision(
    evidence: FlinkEvidence,
    result: FastPathResult,
    source: SourcePosition,
    started_at: datetime,
    decided_at: datetime,
) -> tuple[PaymentDecisionEvent, InvestigationRequestEvent | None]:
    transaction_id = evidence.transaction_id
    decision_id = stable_uuid("decision", transaction_id)
    correlation_id = stable_uuid("correlation", transaction_id)
    digest = evidence_sha256(evidence)
    reference = f"kafka:{source.topic}:{source.partition}:{source.offset}"
    processing_ms = max(0.0, (decided_at - started_at).total_seconds() * 1000)
    ingestion_ms = max(0.0, (decided_at - source.ingested_at).total_seconds() * 1000)
    decision = PaymentDecisionEvent(
        event_id=stable_uuid("decision-event", str(decision_id)),
        decision_id=decision_id,
        transaction_id=transaction_id,
        correlation_id=correlation_id,
        payment_verdict=result.payment_verdict,
        policy_version=result.policy_version,
        triggered_rule_ids=list(result.triggered_rule_ids),
        investigation_required=result.investigation_required,
        investigation_reason=result.investigation_reason,
        source_evidence_references=[reference],
        evidence_sha256=digest,
        transaction_timestamp=evidence.transaction_timestamp,
        ingested_at=source.ingested_at,
        decided_at=decided_at,
        decision_processing_latency_ms=processing_ms,
        ingestion_to_decision_ms=ingestion_ms,
    )
    if not result.investigation_required:
        return decision, None
    investigation_id = stable_uuid("investigation", str(decision_id))
    request = InvestigationRequestEvent(
        event_id=stable_uuid("investigation-request", str(investigation_id)),
        investigation_id=investigation_id,
        decision_id=decision_id,
        transaction_id=transaction_id,
        correlation_id=correlation_id,
        original_payment_verdict=result.payment_verdict,
        routing_reason=result.investigation_reason or "POLICY_SELECTED",
        fast_path_policy_version=result.policy_version,
        evidence=evidence,
        source_evidence_references=[reference],
        requested_at=decided_at,
    )
    return decision, request
