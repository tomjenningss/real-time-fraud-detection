export type InvestigationStageStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETE"
  | "FAILED"
  | "NOT_APPLICABLE"
  | "NOT_OBSERVED";

export type ObservationQuality = "DIRECT" | "DOWNSTREAM_INFERRED" | "UNOBSERVED";

export type InvestigationStageId =
  | "payment_submitted"
  | "postgres_outbox"
  | "kafka"
  | "flink_enrichment"
  | "authoritative_policy"
  | "lightgbm_shadow"
  | "go_correlation"
  | "go_shadow_policy"
  | "customer_questionnaire"
  | "fraud_intelligence_provider"
  | "structured_evidence"
  | "governed_reassessment"
  | "simulated_outcome";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type InvestigationStage = {
  id: InvestigationStageId;
  component: string;
  label: string;
  lane: "INGESTION" | "AUTHORITATIVE" | "SHADOW" | "REASSESSMENT";
  status: InvestigationStageStatus;
  observation: ObservationQuality;
  authority: "AUTHORITATIVE" | "SHADOW_ONLY" | "SIMULATED" | "TRANSPORT";
  occurredAt: string | null;
  observedAt: string | null;
  durationMs: number | null;
  summary: string;
  evidenceReferences: string[];
  details: Record<string, JsonValue>;
  rawJson: JsonValue | null;
};

export type InvestigationTimelineEvent = {
  id: string;
  stageId: InvestigationStageId;
  status: Exclude<InvestigationStageStatus, "PENDING" | "NOT_APPLICABLE" | "NOT_OBSERVED">;
  occurredAt: string;
  observedAt: string | null;
  label: string;
  evidenceReference: string | null;
};

export type FraudIntelligenceView = {
  schemaVersion: "fraud-investigation-view/1.0.0";
  generatedAt: string;
  paymentId: string;
  transactionId: string;
  authoritativeVerdict: "PENDING" | "APPROVED" | "CHALLENGED" | "BLOCKED";
  stages: InvestigationStage[];
  timeline: InvestigationTimelineEvent[];
};

export type FraudIntelligenceViewResponse = { investigation: FraudIntelligenceView };
