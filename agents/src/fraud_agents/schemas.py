from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceStatus(StrEnum):
    AVAILABLE = "AVAILABLE"
    UNKNOWN = "UNKNOWN"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    FAILED = "FAILED"
    CONFLICTING = "CONFLICTING"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    UNKNOWN = "UNKNOWN"


class Verdict(StrEnum):
    APPROVED = "APPROVED"
    CHALLENGED = "CHALLENGED"
    BLOCKED = "BLOCKED"


class FlinkEvidence(StrictModel):
    assessment_type: Literal["transaction"] = "transaction"
    transaction_id: str = Field(min_length=1, max_length=128)
    user_id: str = Field(min_length=1, max_length=128)
    amount: float = Field(ge=0, le=100_000_000)
    merchant_id: str = Field(min_length=1, max_length=256)
    transaction_timestamp: datetime
    transactions_1m: int = Field(ge=1)
    transactions_2m: int = Field(ge=1)
    transactions_10m: int = Field(ge=1)
    distinct_merchants_2m: int = Field(ge=1)
    total_amount_2m: float = Field(ge=0)
    signals: list[Literal["HIGH_VELOCITY", "MERCHANT_HOPPING"]]
    signal_ids: list[str]
    risk_level: Literal["LOW", "HIGH"]
    assessment_timestamp: datetime
    evidence_source: Literal["flink"]

    @field_validator("transaction_id", "user_id", "merchant_id")
    @classmethod
    def reject_control_characters(cls, value: str) -> str:
        if any(ord(char) < 32 for char in value):
            raise ValueError("control characters are not permitted")
        return value

    @model_validator(mode="after")
    def validate_canonical_consistency(self) -> FlinkEvidence:
        if not (self.transactions_1m <= self.transactions_2m <= self.transactions_10m):
            raise ValueError("rolling transaction counts must be monotonic")
        if len(set(self.signals)) != len(self.signals):
            raise ValueError("signals must be unique")
        expected = {f"txn:{self.transaction_id}:{signal}" for signal in self.signals}
        if set(self.signal_ids) != expected:
            raise ValueError("signal_ids do not match canonical transaction signals")
        if (bool(self.signals)) != (self.risk_level == "HIGH"):
            raise ValueError("Flink risk_level is inconsistent with signals")
        return self


class TransactionContext(StrictModel):
    payment_channel: Literal["CARD_PRESENT", "ECOMMERCE", "OTHER", "UNKNOWN"] = "UNKNOWN"
    device_lat: float | None = None
    device_lon: float | None = None
    merchant_lat: float | None = None
    merchant_lon: float | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


class HistoricalEvidence(StrictModel):
    source: Literal["payments_engine", "fixture"]
    status: EvidenceStatus
    reference_id: str
    mean_amount: float | None = Field(default=None, ge=0)
    standard_deviation: float | None = Field(default=None, ge=0)
    sample_size: int | None = Field(default=None, ge=0)


class InvestigationInput(StrictModel):
    flink: FlinkEvidence
    context: TransactionContext = Field(default_factory=TransactionContext)
    historical: HistoricalEvidence | None = None


class GeoToolResult(StrictModel):
    distance_km: float | None
    risk_level: RiskLevel
    applicable: bool
    status: EvidenceStatus
    confidence: Literal["HIGH", "MEDIUM", "LOW", "NONE"]
    explanation: str
    source: Literal["deterministic_haversine"] = "deterministic_haversine"


class GeoAssessment(StrictModel):
    status: EvidenceStatus
    canonical: GeoToolResult
    explanation: str
    explanation_source: Literal["fixture", "claude"]
    model: str | None = None


class BehaviourCanonical(StrictModel):
    transaction_id: str
    transactions_1m: int
    transactions_2m: int
    transactions_10m: int
    distinct_merchants_2m: int
    total_amount_2m: float
    signals: list[str]
    signal_ids: list[str]
    historical: HistoricalEvidence | None = None
    source: Literal["flink_enrichment"] = "flink_enrichment"


class BehaviourAssessment(StrictModel):
    status: EvidenceStatus
    risk_level: RiskLevel
    canonical: BehaviourCanonical
    explanation: str
    explanation_source: Literal["fixture", "claude"]
    source_references: list[str]
    model: str | None = None


class EvidenceBundle(StrictModel):
    investigation_id: UUID
    transaction_id: str
    flink: FlinkEvidence
    geo: GeoAssessment
    behaviour: BehaviourAssessment
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class EvidenceReference(StrictModel):
    investigation_id: UUID
    transaction_id: str


class PolicyResult(StrictModel):
    transaction_id: str
    verdict: Verdict
    triggered_rule_ids: list[str]
    policy_version: str
    reason: str


class ExternalVerdict(StrictModel):
    transaction_id: str
    verdict: Verdict
    reason: str


class ModelUsage(StrictModel):
    agent: str
    model: str
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    latency_ms: float = Field(ge=0)
    estimated_cost_usd: float = Field(ge=0)
    call_number: int = Field(ge=1)


class ToolAudit(StrictModel):
    agent: str
    tool_name: str
    status: Literal["ok", "error", "rejected"]
    source: str
    detail: dict[str, Any] = Field(default_factory=dict)


class AuditRecord(StrictModel):
    investigation_id: UUID = Field(default_factory=uuid4)
    transaction_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    mode: Literal["dry-run", "live"]
    agent_models: dict[str, str]
    tool_calls: list[ToolAudit] = Field(default_factory=list)
    canonical_evidence_references: list[str] = Field(default_factory=list)
    policy_version: str | None = None
    triggered_rules: list[str] = Field(default_factory=list)
    final_verdict: Verdict | None = None
    deterministic_reason: str | None = None
    model_usage: list[ModelUsage] = Field(default_factory=list)
    estimated_api_cost_usd: float = 0
    latency_ms: float = 0
    failures: list[str] = Field(default_factory=list)
