import "server-only";

import type {
  FraudIntelligenceView,
  InvestigationStage,
  InvestigationStageId,
  InvestigationStageStatus,
  InvestigationTimelineEvent,
  JsonValue,
  ObservationQuality,
} from "@/lib/fraud-intelligence-view";
import { ApiError } from "@/lib/server/api-errors";
import { query } from "@/lib/server/db";

type JsonObject = Record<string, unknown>;

type BaseRow = {
  payment_id: string;
  transaction_id: string;
  submitted_at: Date;
  payment_status: "PENDING" | "APPROVED" | "CHALLENGED" | "BLOCKED";
  raw_event_id: string;
  raw_topic: string;
  outbox_status: "PENDING" | "CLAIMED" | "PUBLISHED";
  outbox_attempts: number;
  outbox_error: string | null;
  outbox_created_at: Date;
  outbox_published_at: Date | null;
  decision_id: string | null;
  policy_version: string | null;
  decision_payload: JsonObject | null;
  enrichment_evidence: JsonObject | null;
  decided_at: Date | null;
  router_observed_at: Date | null;
  router_topic: string | null;
  router_partition: number | null;
  router_offset: string | null;
};

type SourceRow = {
  event_id: string;
  event_kind: string;
  source_topic: string;
  source_partition: number;
  source_offset: string;
  event_timestamp: Date;
  payload: JsonObject;
  valid: boolean;
  validation_error: string | null;
  consumed_at: Date;
};

type CorrelationRow = {
  revision: string;
  source_event_id: string;
  assessment: JsonObject;
  created_at: Date;
  outbox_status: string | null;
  published_at: Date | null;
};

type ShadowRow = {
  source_assessment_id: string;
  source_revision: string;
  processing_status: string;
  status_reason: string | null;
  consumed_at: Date;
  shadow_evaluation_id: string | null;
  policy_version: string;
  proposed_action: string | null;
  original_payment_verdict: string | null;
  differs_from_original: boolean | null;
  decision: JsonObject | null;
  evaluated_at: Date | null;
  evaluation_latency_ms: number | null;
};

type CustomerInvestigationRow = {
  customer_investigation_id: string;
  status: string;
  questionnaire_version: string;
  agent_invocation_count: number;
  started_at: Date;
  questionnaire_completed_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

type CustomerEventRow = {
  event_id: string;
  event_type: string;
  event_payload: JsonObject;
  occurred_at: Date;
};

type AnswerRow = {
  answer_id: string;
  question_id: string;
  question_source: string;
  answer_payload: JsonObject;
  answered_at: Date;
};

type ExtractionRow = {
  extraction_id: string;
  invocation_number: number;
  agent_name: string;
  agent_version: string;
  provider: string;
  model: string;
  evidence_schema_version: string;
  response_payload: JsonObject | null;
  schema_valid: boolean;
  latency_ms: number;
  error_type: string | null;
  started_at: Date;
  finished_at: Date;
};

type ReassessmentRow = {
  reassessment_id: string;
  extraction_id: string;
  policy_version: string;
  outcome: string;
  reason_codes: unknown;
  evidence_snapshot: JsonObject;
  policy_trace: unknown;
  guidance_contract_version: string | null;
  guidance_payload: JsonObject | null;
  reassessed_at: Date;
};

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const serialised = json(value);
  return serialised && typeof serialised === "object" && !Array.isArray(serialised)
    ? serialised
    : { value: serialised };
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function duration(start: Date, finish: Date | null): number | null {
  return finish ? Math.max(0, finish.getTime() - start.getTime()) : null;
}

function stage(
  id: InvestigationStageId,
  component: string,
  label: string,
  lane: InvestigationStage["lane"],
  status: InvestigationStageStatus,
  observation: ObservationQuality,
  summary: string,
  options: Partial<Omit<InvestigationStage, "id" | "component" | "label" | "lane" | "status" | "observation" | "summary">> = {},
): InvestigationStage {
  return {
    id,
    component,
    label,
    lane,
    status,
    observation,
    authority: lane === "INGESTION" ? "TRANSPORT"
      : lane === "SHADOW" ? "SHADOW_ONLY"
        : lane === "REASSESSMENT" ? "SIMULATED" : "AUTHORITATIVE",
    summary,
    occurredAt: null,
    observedAt: null,
    durationMs: null,
    evidenceReferences: [],
    details: {},
    rawJson: null,
    ...options,
  };
}

function timelineEvent(
  id: string,
  stageId: InvestigationStageId,
  status: InvestigationTimelineEvent["status"],
  occurredAt: Date,
  label: string,
  evidenceReference: string | null = null,
  observedAt: Date | null = null,
): InvestigationTimelineEvent {
  return {
    id,
    stageId,
    status,
    occurredAt: occurredAt.toISOString(),
    observedAt: iso(observedAt),
    label,
    evidenceReference,
  };
}

function humanEvidenceSummary(payload: JsonObject | null): string[] {
  if (!payload) return [];
  const summary: string[] = [];
  if (typeof payload.paymentRecognition === "string") {
    summary.push(`Payment recognition: ${payload.paymentRecognition.replaceAll("_", " ").toLowerCase()}.`);
  }
  if (typeof payload.beneficiaryRelationship === "string") {
    summary.push(`Beneficiary relationship: ${payload.beneficiaryRelationship.replaceAll("_", " ").toLowerCase()}.`);
  }
  if (typeof payload.paymentPurpose === "string") {
    summary.push(`Payment purpose: ${payload.paymentPurpose.replaceAll("_", " ").toLowerCase()}.`);
  }
  if (typeof payload.thirdPartyInfluence === "string") {
    summary.push(`Third-party influence: ${payload.thirdPartyInfluence.replaceAll("_", " ").toLowerCase()}.`);
  }
  if (Array.isArray(payload.verificationClaims) && payload.verificationClaims.length > 0) {
    summary.push(`Customer-stated verification: ${payload.verificationClaims
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replaceAll("_", " ").toLowerCase()).join(", ")}.`);
  }
  if (Array.isArray(payload.scamIndicators)) {
    const indicators = payload.scamIndicators.filter((item): item is string => typeof item === "string");
    summary.push(indicators.includes("NONE")
      ? "No contracted scam indicator was extracted."
      : `Persisted indicators: ${indicators.map((item) => item.replaceAll("_", " ").toLowerCase()).join(", ")}.`);
  }
  if (typeof payload.uncertainty === "string") {
    summary.push(`Contracted uncertainty: ${payload.uncertainty.toLowerCase()}.`);
  }
  if (Array.isArray(payload.missingEvidence) && payload.missingEvidence.length > 0) {
    summary.push(`Missing evidence: ${payload.missingEvidence.join(", ")}.`);
  }
  return summary;
}

export async function getFraudIntelligenceView(
  customerId: string,
  paymentId: string,
): Promise<FraudIntelligenceView> {
  const baseResult = await query<BaseRow>(`
    SELECT attempt.payment_id, attempt.transaction_id, attempt.submitted_at,
           status.payment_status,
           raw.event_id AS raw_event_id, raw.destination_topic AS raw_topic,
           raw.status AS outbox_status, raw.attempts AS outbox_attempts,
           raw.last_error_type AS outbox_error, raw.created_at AS outbox_created_at,
           raw.published_at AS outbox_published_at,
           decision.decision_id, decision.policy_version, decision.decision_payload,
           decision.enrichment_evidence, decision.decided_at,
           inbox.consumed_at AS router_observed_at,
           inbox.source_topic AS router_topic, inbox.source_partition AS router_partition,
           inbox.source_offset::text AS router_offset
    FROM banking_payment_attempts attempt
    JOIN banking_payment_status status ON status.payment_id = attempt.payment_id
    JOIN outbox_events raw
      ON raw.aggregate_type = 'banking_payment_raw' AND raw.aggregate_id = attempt.payment_id
    LEFT JOIN payment_decisions decision ON decision.transaction_id = attempt.transaction_id
    LEFT JOIN consumed_events inbox
      ON inbox.consumer_name = 'decision-router'
     AND inbox.logical_event_id = decision.decision_id
    WHERE attempt.customer_id = $1 AND attempt.payment_id = $2
    LIMIT 1
  `, [customerId, paymentId]);
  const base = baseResult.rows[0];
  if (!base) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Fictional payment attempt not found.");

  const [sourcesResult, correlationsResult, shadowsResult, customerResult] = await Promise.all([
    query<SourceRow>(`
      SELECT event_id, event_kind, source_topic, source_partition, source_offset::text,
             event_timestamp, payload, valid, validation_error, consumed_at
      FROM fraud_assessment_source_events
      WHERE transaction_id = $1
      ORDER BY consumed_at, event_id
    `, [base.transaction_id]),
    query<CorrelationRow>(`
      SELECT history.revision::text, history.source_event_id, history.assessment,
             history.created_at, publication.status AS outbox_status, publication.published_at
      FROM fraud_assessment_history history
      LEFT JOIN fraud_assessment_outbox publication
        ON publication.transaction_id = history.transaction_id
       AND publication.revision = history.revision
      WHERE history.transaction_id = $1
      ORDER BY history.revision
    `, [base.transaction_id]),
    query<ShadowRow>(`
      SELECT event.source_assessment_id, event.source_revision::text,
             event.processing_status, event.status_reason, event.consumed_at,
             history.shadow_evaluation_id, event.policy_version,
             history.proposed_action, history.original_payment_verdict,
             history.differs_from_original, history.decision,
             history.evaluated_at, history.evaluation_latency_ms
      FROM fraud_shadow_assessment_events event
      LEFT JOIN fraud_shadow_decision_history history
        ON history.source_assessment_id = event.source_assessment_id
       AND history.source_revision = event.source_revision
       AND history.policy_version = event.policy_version
      WHERE event.transaction_id = $1
      ORDER BY event.source_revision, event.consumed_at
    `, [base.transaction_id]),
    query<CustomerInvestigationRow>(`
      SELECT customer_investigation_id, status, questionnaire_version,
             agent_invocation_count, started_at, questionnaire_completed_at,
             completed_at, updated_at
      FROM customer_fraud_investigations
      WHERE customer_id = $1 AND payment_id = $2
      LIMIT 1
    `, [customerId, paymentId]),
  ]);

  const sources = sourcesResult.rows;
  const correlations = correlationsResult.rows;
  const shadows = shadowsResult.rows;
  const customerInvestigation = customerResult.rows[0] ?? null;
  const [customerEvents, answers, extractions, reassessments] = customerInvestigation
    ? await Promise.all([
        query<CustomerEventRow>(`
          SELECT event_id, event_type, event_payload, occurred_at
          FROM customer_fraud_investigation_events
          WHERE customer_investigation_id = $1 ORDER BY occurred_at, event_id
        `, [customerInvestigation.customer_investigation_id]),
        query<AnswerRow>(`
          SELECT answer_id, question_id, question_source, answer_payload, answered_at
          FROM customer_questionnaire_answers
          WHERE customer_investigation_id = $1 ORDER BY answered_at, answer_id
        `, [customerInvestigation.customer_investigation_id]),
        query<ExtractionRow>(`
          SELECT extraction_id, invocation_number, agent_name, agent_version, provider,
                 model, evidence_schema_version, response_payload, schema_valid,
                 latency_ms, error_type, started_at, finished_at
          FROM fraud_intelligence_extractions
          WHERE customer_investigation_id = $1 ORDER BY invocation_number
        `, [customerInvestigation.customer_investigation_id]),
        query<ReassessmentRow>(`
          SELECT reassessment_id, extraction_id, policy_version, outcome, reason_codes,
                 evidence_snapshot, policy_trace, guidance_contract_version,
                 guidance_payload, reassessed_at
          FROM customer_fraud_reassessments
          WHERE customer_investigation_id = $1 ORDER BY reassessed_at, reassessment_id
        `, [customerInvestigation.customer_investigation_id]),
      ])
    : [{ rows: [] as CustomerEventRow[] }, { rows: [] as AnswerRow[] }, { rows: [] as ExtractionRow[] }, { rows: [] as ReassessmentRow[] }];

  const mlSource = [...sources].reverse().find((item) => item.event_kind === "ML") ?? null;
  const latestCorrelation = correlations.at(-1) ?? null;
  const latestShadow = [...shadows].reverse().find((item) => item.shadow_evaluation_id) ?? shadows.at(-1) ?? null;
  const latestExtraction = extractions.rows.at(-1) ?? null;
  const latestReassessment = reassessments.rows.at(-1) ?? null;
  const challenged = base.payment_status === "CHALLENGED";
  const terminal = base.payment_status !== "PENDING";
  const historicalMissing = terminal ? "NOT_OBSERVED" : "PENDING";
  const events: InvestigationTimelineEvent[] = [];

  const stages: InvestigationStage[] = [
    stage("payment_submitted", "Glaramara", "Payment submitted", "INGESTION", "COMPLETE", "DIRECT", "The fictional payment attempt was committed without a ledger effect.", {
      occurredAt: iso(base.submitted_at), observedAt: iso(base.submitted_at),
      evidenceReferences: [`payment:${base.payment_id}`],
      details: jsonObject({ paymentId: base.payment_id, transactionId: base.transaction_id, ledgerEffect: "NONE", simulated: true }),
    }),
    stage("postgres_outbox", "PostgreSQL", "Transactional outbox", "INGESTION", "COMPLETE", "DIRECT", "The raw payment event was committed atomically with the payment attempt.", {
      occurredAt: iso(base.outbox_created_at), observedAt: iso(base.outbox_created_at),
      evidenceReferences: [`outbox:${base.raw_event_id}`],
      details: jsonObject({ eventId: base.raw_event_id, topic: base.raw_topic, status: base.outbox_status, attempts: base.outbox_attempts, lastErrorType: base.outbox_error }),
    }),
    stage("kafka", "Apache Kafka", "Kafka event stream", "INGESTION",
      base.outbox_status === "PUBLISHED" ? "COMPLETE" : base.outbox_status === "CLAIMED" ? "PROCESSING" : "PENDING",
      base.outbox_published_at ? "DIRECT" : "UNOBSERVED",
      base.outbox_published_at ? "Kafka acknowledged the raw payment event." : base.outbox_error ? "Publication is retrying after a recorded error." : "Waiting for a Kafka acknowledgement.", {
        occurredAt: iso(base.outbox_published_at), observedAt: iso(base.outbox_published_at),
        durationMs: duration(base.outbox_created_at, base.outbox_published_at),
        evidenceReferences: [`outbox:${base.raw_event_id}`, `topic:${base.raw_topic}`],
        details: jsonObject({ topic: base.raw_topic, eventId: base.raw_event_id, publishAcknowledgedAt: iso(base.outbox_published_at), attempts: base.outbox_attempts, lastErrorType: base.outbox_error }),
      }),
    stage("flink_enrichment", "Apache Flink", "Event-time enrichment", "INGESTION",
      base.enrichment_evidence || base.router_observed_at ? "COMPLETE" : historicalMissing,
      base.enrichment_evidence ? "DIRECT" : base.router_observed_at ? "DOWNSTREAM_INFERRED" : "UNOBSERVED",
      base.enrichment_evidence ? "Validated event-time features were persisted with the immutable decision." : base.router_observed_at ? "The enriched record was observed by the router; its exact historical payload was not retained." : "No transaction-scoped enrichment observation is available yet.", {
        occurredAt: typeof base.enrichment_evidence?.assessment_timestamp === "string" ? base.enrichment_evidence.assessment_timestamp : null,
        observedAt: iso(base.router_observed_at),
        evidenceReferences: base.router_topic && base.router_partition !== null && base.router_offset !== null
          ? [`kafka:${base.router_topic}:${base.router_partition}:${base.router_offset}`] : [],
        details: jsonObject(base.enrichment_evidence ?? { observation: "downstream only", observedAt: iso(base.router_observed_at) }),
      }),
    stage("authoritative_policy", "Python", "Authoritative router policy", "AUTHORITATIVE",
      base.decision_id ? "COMPLETE" : "PENDING", base.decision_id ? "DIRECT" : "UNOBSERVED",
      base.decision_id ? `${base.payment_status} is the immutable customer-facing verdict.` : "Waiting for the deterministic router decision.", {
        occurredAt: iso(base.decided_at), observedAt: iso(base.router_observed_at),
        durationMs: typeof base.decision_payload?.decision_processing_latency_ms === "number" ? base.decision_payload.decision_processing_latency_ms : null,
        evidenceReferences: base.decision_id ? [`decision:${base.decision_id}`] : [],
        details: jsonObject({ decisionId: base.decision_id, verdict: base.payment_status, policyVersion: base.policy_version, ...(base.decision_payload ?? {}) }),
      }),
    stage("lightgbm_shadow", "Python LightGBM", "LightGBM scorer", "SHADOW",
      mlSource ? (mlSource.valid ? "COMPLETE" : "FAILED") : historicalMissing,
      mlSource ? "DIRECT" : "UNOBSERVED",
      mlSource ? "Synthetic CPU model evidence was recorded for shadow evaluation only." : "No persisted LightGBM output was observed.", {
        occurredAt: iso(mlSource?.event_timestamp), observedAt: iso(mlSource?.consumed_at),
        durationMs: typeof mlSource?.payload.scoring_latency_ms === "number" ? mlSource.payload.scoring_latency_ms : null,
        evidenceReferences: mlSource ? [`event:${mlSource.event_id}`, `kafka:${mlSource.source_topic}:${mlSource.source_partition}:${mlSource.source_offset}`] : [],
        details: jsonObject(mlSource ? { nonAuthoritative: true, validationError: mlSource.validation_error, ...mlSource.payload } : { nonAuthoritative: true }),
      }),
    stage("go_correlation", "Go", "Evidence correlator", "SHADOW",
      latestCorrelation ? "COMPLETE" : historicalMissing, latestCorrelation ? "DIRECT" : "UNOBSERVED",
      latestCorrelation ? `Persisted correlated assessment revision ${latestCorrelation.revision}.` : "No correlated assessment revision was observed.", {
        occurredAt: iso(latestCorrelation?.created_at), observedAt: iso(latestCorrelation?.created_at),
        evidenceReferences: latestCorrelation ? [`assessment:${base.transaction_id}:${latestCorrelation.revision}`] : [],
        details: jsonObject(latestCorrelation ? { revision: latestCorrelation.revision, publicationStatus: latestCorrelation.outbox_status, publishedAt: iso(latestCorrelation.published_at), assessment: latestCorrelation.assessment } : {}),
      }),
    stage("go_shadow_policy", "Go", "Shadow decision engine", "SHADOW",
      latestShadow?.shadow_evaluation_id ? "COMPLETE"
        : latestShadow?.processing_status === "INVALID_INPUTS" ? "FAILED"
          : latestShadow ? "PROCESSING" : historicalMissing,
      latestShadow ? "DIRECT" : "UNOBSERVED",
      latestShadow?.shadow_evaluation_id ? `${latestShadow.proposed_action} was proposed in shadow and cannot change the payment.`
        : latestShadow ? `Shadow policy recorded ${latestShadow.processing_status.toLowerCase().replaceAll("_", " ")}.`
          : "No Go shadow evaluation was observed.", {
        occurredAt: iso(latestShadow?.evaluated_at ?? latestShadow?.consumed_at), observedAt: iso(latestShadow?.consumed_at),
        durationMs: latestShadow?.evaluation_latency_ms ?? null,
        evidenceReferences: latestShadow ? [`shadow-assessment:${latestShadow.source_assessment_id}:${latestShadow.source_revision}`] : [],
        details: jsonObject(latestShadow ? { nonAuthoritative: true, policyVersion: latestShadow.policy_version, processingStatus: latestShadow.processing_status, statusReason: latestShadow.status_reason, proposedAction: latestShadow.proposed_action, originalPaymentVerdict: latestShadow.original_payment_verdict, differsFromOriginal: latestShadow.differs_from_original, decision: latestShadow.decision } : { nonAuthoritative: true }),
      }),
  ];

  const questionnaireStatus: InvestigationStageStatus = !challenged ? "NOT_APPLICABLE"
    : customerInvestigation?.questionnaire_completed_at ? "COMPLETE"
      : customerInvestigation ? "PROCESSING" : "PENDING";
  stages.push(stage("customer_questionnaire", "Customer", "Security questionnaire", "REASSESSMENT", questionnaireStatus,
    customerInvestigation ? "DIRECT" : "UNOBSERVED",
    !challenged ? "The authoritative verdict did not select the customer evidence journey."
      : customerInvestigation?.questionnaire_completed_at ? `${answers.rows.length} persisted customer answers completed the questionnaire.`
        : customerInvestigation ? `${answers.rows.length} answers are durably recorded.` : "The challenged payment is waiting for the customer to start the check.", {
      occurredAt: iso(customerInvestigation?.questionnaire_completed_at ?? customerInvestigation?.started_at),
      observedAt: iso(customerInvestigation?.updated_at),
      durationMs: customerInvestigation ? duration(customerInvestigation.started_at, customerInvestigation.questionnaire_completed_at) : null,
      evidenceReferences: customerInvestigation ? [`customer-investigation:${customerInvestigation.customer_investigation_id}`] : [],
      details: jsonObject(customerInvestigation ? {
        investigationId: customerInvestigation.customer_investigation_id,
        questionnaireVersion: customerInvestigation.questionnaire_version,
        status: customerInvestigation.status,
        answers: answers.rows.map((answer) => ({
          questionId: answer.question_id,
          value: typeof answer.answer_payload.value === "string" ? answer.answer_payload.value : null,
          source: answer.question_source,
          answeredAt: iso(answer.answered_at),
        })),
      } : {}),
    }));

  const providerIsWatsonx = latestExtraction?.provider === "watsonx-orchestrate-rest";
  const providerLabel = providerIsWatsonx ? "watsonx Orchestrate" : latestExtraction?.provider === "mock"
    ? "Mock Fraud Intelligence" : "Fraud Intelligence provider";
  const providerStatus: InvestigationStageStatus = !challenged ? "NOT_APPLICABLE"
    : latestExtraction ? latestExtraction.schema_valid ? "COMPLETE" : "FAILED"
      : customerInvestigation?.status === "EXTRACTING" ? "PROCESSING" : "PENDING";
  stages.push(stage("fraud_intelligence_provider", providerIsWatsonx ? "IBM" : "Provider", providerLabel, "REASSESSMENT", providerStatus,
    latestExtraction ? "DIRECT" : "UNOBSERVED",
    !challenged ? "Provider analysis is not applicable to this verdict."
      : latestExtraction?.schema_valid ? `${providerLabel} returned a validated structured response.`
        : latestExtraction ? `${providerLabel} failed with a persisted ${latestExtraction.error_type ?? "unknown"} error.`
          : customerInvestigation?.status === "EXTRACTING" ? "A persisted extraction claim is currently processing." : "No provider invocation has been recorded.", {
      occurredAt: iso(latestExtraction?.finished_at ?? (customerInvestigation?.status === "EXTRACTING" ? customerInvestigation.updated_at : null)),
      observedAt: iso(latestExtraction?.finished_at), durationMs: latestExtraction?.latency_ms ?? null,
      evidenceReferences: latestExtraction ? [`extraction:${latestExtraction.extraction_id}`] : [],
      details: jsonObject(latestExtraction ? {
        standout: providerIsWatsonx,
        humanSummary: humanEvidenceSummary(latestExtraction.response_payload),
        provider: latestExtraction.provider,
        model: latestExtraction.model,
        agentName: latestExtraction.agent_name,
        agentVersion: latestExtraction.agent_version,
        invocationNumber: latestExtraction.invocation_number,
        schemaVersion: latestExtraction.evidence_schema_version,
        schemaValid: latestExtraction.schema_valid,
        latencyMs: latestExtraction.latency_ms,
        startedAt: iso(latestExtraction.started_at),
        finishedAt: iso(latestExtraction.finished_at),
        errorType: latestExtraction.error_type,
        provenance: latestExtraction.response_payload?.provenance ?? [],
        structuredResponse: latestExtraction.response_payload,
        contribution: {
          customerResponses: answers.rows.map((answer) => ({
            questionId: answer.question_id,
            value: typeof answer.answer_payload.value === "string" ? answer.answer_payload.value : null,
            answeredAt: iso(answer.answered_at),
          })),
          customerExplanation: answers.rows.find(
            (answer) => answer.question_id === "payment_circumstances",
          )?.answer_payload.value ?? null,
          extractedFindings: latestExtraction.response_payload,
          fraudIndicators: latestExtraction.response_payload?.scamIndicators ?? [],
          evidenceProvenance: latestExtraction.response_payload?.provenance ?? [],
          matchedDeterministicRules: latestReassessment?.policy_trace ?? [],
          simulatedAction: latestReassessment?.outcome ?? null,
          policyVersion: latestReassessment?.policy_version ?? null,
          customerGuidance: latestReassessment?.guidance_payload ?? null,
          authoritativeVerdict: base.payment_status,
          ledgerEffect: "NONE",
        },
      } : {}),
    }));

  const structuredStatus: InvestigationStageStatus = !challenged ? "NOT_APPLICABLE"
    : latestExtraction ? latestExtraction.schema_valid ? "COMPLETE" : "FAILED"
      : customerInvestigation?.status === "EXTRACTING" ? "PROCESSING" : "PENDING";
  stages.push(stage("structured_evidence", "Validated contract", "Structured evidence", "REASSESSMENT", structuredStatus,
    latestExtraction ? "DIRECT" : "UNOBSERVED",
    latestExtraction?.schema_valid ? "The response passed the strict evidence contract."
      : latestExtraction ? "No valid structured evidence was produced." : challenged ? "Waiting for a validated provider response." : "Not applicable.", {
      occurredAt: iso(latestExtraction?.finished_at), observedAt: iso(latestExtraction?.finished_at),
      evidenceReferences: latestExtraction ? [`extraction:${latestExtraction.extraction_id}`] : [],
      details: jsonObject(latestExtraction?.response_payload ?? {}),
    }));

  const reassessmentStatus: InvestigationStageStatus = !challenged ? "NOT_APPLICABLE"
    : latestReassessment ? "COMPLETE" : customerInvestigation?.status === "FAILED" ? "FAILED" : "PENDING";
  stages.push(stage("governed_reassessment", "Deterministic policy", "Governed reassessment", "REASSESSMENT", reassessmentStatus,
    latestReassessment ? "DIRECT" : "UNOBSERVED",
    latestReassessment ? `${latestReassessment.policy_version} evaluated only the validated evidence.`
      : challenged ? "No governed reassessment has been recorded." : "Not applicable.", {
      occurredAt: iso(latestReassessment?.reassessed_at), observedAt: iso(latestReassessment?.reassessed_at),
      evidenceReferences: latestReassessment ? [`reassessment:${latestReassessment.reassessment_id}`] : [],
      details: jsonObject(latestReassessment ? { policyVersion: latestReassessment.policy_version, reasonCodes: latestReassessment.reason_codes, policyTrace: latestReassessment.policy_trace, evidenceSnapshot: latestReassessment.evidence_snapshot, originalVerdict: base.payment_status, immutableOriginalDecision: true } : {}),
    }));
  stages.push(stage("simulated_outcome", "Glaramara", "Simulated outcome", "REASSESSMENT",
    !challenged ? "NOT_APPLICABLE" : latestReassessment ? "COMPLETE" : customerInvestigation?.status === "FAILED" ? "FAILED" : "PENDING",
    latestReassessment ? "DIRECT" : "UNOBSERVED",
    latestReassessment ? `${latestReassessment.outcome} is a separate simulated resolution; the original ${base.payment_status} verdict remains immutable.`
      : challenged ? "No simulated reassessment outcome is available." : "Not applicable.", {
      occurredAt: iso(latestReassessment?.reassessed_at), observedAt: iso(latestReassessment?.reassessed_at),
      evidenceReferences: latestReassessment ? [`reassessment:${latestReassessment.reassessment_id}`] : [],
      details: jsonObject(latestReassessment ? { outcome: latestReassessment.outcome, ledgerEffect: "NONE", simulated: true, originalVerdict: base.payment_status } : {}),
    }));
  const guidanceStatus: InvestigationStageStatus = !challenged ? "NOT_APPLICABLE"
    : latestReassessment?.guidance_payload ? "COMPLETE"
      : latestReassessment ? "NOT_OBSERVED"
        : customerInvestigation?.status === "FAILED" ? "FAILED" : "PENDING";
  stages.push(stage("customer_guidance", "Glaramara", "Prevention guidance", "REASSESSMENT",
    guidanceStatus, latestReassessment?.guidance_payload ? "DIRECT" : "UNOBSERVED",
    latestReassessment?.guidance_payload
      ? `${latestReassessment.guidance_contract_version} selected and rendered persisted customer guidance.`
      : latestReassessment ? "This historical reassessment predates persisted customer guidance."
        : challenged ? "No persisted customer guidance is available yet." : "Not applicable.", {
      occurredAt: iso(latestReassessment?.guidance_payload ? latestReassessment.reassessed_at : null),
      observedAt: iso(latestReassessment?.guidance_payload ? latestReassessment.reassessed_at : null),
      evidenceReferences: latestReassessment?.guidance_payload
        ? [`reassessment:${latestReassessment.reassessment_id}`, ...(
            Array.isArray(latestReassessment.guidance_payload.evidenceFindingIds)
              ? latestReassessment.guidance_payload.evidenceFindingIds.map((id) => `finding:${id}`)
              : []
          )] : [],
      details: jsonObject(latestReassessment?.guidance_payload ? {
        contractVersion: latestReassessment.guidance_contract_version,
        guidance: latestReassessment.guidance_payload,
        sourcePolicyVersion: latestReassessment.policy_version,
        sourcePolicyTrace: latestReassessment.policy_trace,
        persisted: true,
        regeneratedOnReplay: false,
      } : { historicalRecord: Boolean(latestReassessment), regeneratedOnReplay: false }),
    }));

  events.push(
    timelineEvent(`payment:${base.payment_id}`, "payment_submitted", "COMPLETE", base.submitted_at, "Payment submitted", `payment:${base.payment_id}`),
    timelineEvent(`outbox:${base.raw_event_id}`, "postgres_outbox", "COMPLETE", base.outbox_created_at, "Transactional outbox committed", `outbox:${base.raw_event_id}`),
  );
  if (base.outbox_published_at) events.push(timelineEvent(`kafka:${base.raw_event_id}`, "kafka", "COMPLETE", base.outbox_published_at, "Kafka acknowledged raw event", `topic:${base.raw_topic}`));
  if (base.enrichment_evidence && typeof base.enrichment_evidence.assessment_timestamp === "string") {
    events.push(timelineEvent(`flink:${base.transaction_id}`, "flink_enrichment", "COMPLETE", new Date(base.enrichment_evidence.assessment_timestamp), "Flink enrichment emitted", `transaction:${base.transaction_id}`, base.router_observed_at));
  } else if (base.router_observed_at) {
    events.push(timelineEvent(`flink-observed:${base.transaction_id}`, "flink_enrichment", "COMPLETE", base.router_observed_at, "Enrichment observed downstream", null, base.router_observed_at));
  }
  if (base.decided_at && base.decision_id) events.push(timelineEvent(`decision:${base.decision_id}`, "authoritative_policy", "COMPLETE", base.decided_at, `Authoritative verdict: ${base.payment_status}`, `decision:${base.decision_id}`, base.router_observed_at));
  if (mlSource) events.push(timelineEvent(`ml:${mlSource.event_id}`, "lightgbm_shadow", mlSource.valid ? "COMPLETE" : "FAILED", mlSource.event_timestamp, mlSource.valid ? "LightGBM shadow score recorded" : "LightGBM evidence rejected", `event:${mlSource.event_id}`, mlSource.consumed_at));
  for (const correlation of correlations) events.push(timelineEvent(`correlation:${base.transaction_id}:${correlation.revision}`, "go_correlation", "COMPLETE", correlation.created_at, `Correlation revision ${correlation.revision}`, `assessment:${base.transaction_id}:${correlation.revision}`));
  for (const shadow of shadows) events.push(timelineEvent(`shadow:${shadow.source_assessment_id}:${shadow.source_revision}`, "go_shadow_policy", shadow.processing_status === "INVALID_INPUTS" ? "FAILED" : shadow.shadow_evaluation_id ? "COMPLETE" : "PROCESSING", shadow.evaluated_at ?? shadow.consumed_at, shadow.shadow_evaluation_id ? `Shadow proposal: ${shadow.proposed_action}` : `Shadow status: ${shadow.processing_status}`, `shadow-assessment:${shadow.source_assessment_id}:${shadow.source_revision}`, shadow.consumed_at));
  if (customerInvestigation) events.push(timelineEvent(`questionnaire:${customerInvestigation.customer_investigation_id}`, "customer_questionnaire", "PROCESSING", customerInvestigation.started_at, "Questionnaire started", `customer-investigation:${customerInvestigation.customer_investigation_id}`));
  for (const event of customerEvents.rows) {
    if (event.event_type === "QUESTIONNAIRE_COMPLETED") events.push(timelineEvent(`questionnaire-event:${event.event_id}`, "customer_questionnaire", "COMPLETE", event.occurred_at, "Questionnaire completed", `event:${event.event_id}`));
    if (event.event_type === "FAILED") events.push(timelineEvent(`investigation-failed:${event.event_id}`, "fraud_intelligence_provider", "FAILED", event.occurred_at, "Fraud Intelligence extraction failed", `event:${event.event_id}`));
  }
  for (const extraction of extractions.rows) {
    events.push(timelineEvent(`extraction-start:${extraction.extraction_id}`, "fraud_intelligence_provider", "PROCESSING", extraction.started_at, `${extraction.provider} invocation started`, `extraction:${extraction.extraction_id}`));
    events.push(timelineEvent(`extraction-finish:${extraction.extraction_id}`, "fraud_intelligence_provider", extraction.schema_valid ? "COMPLETE" : "FAILED", extraction.finished_at, extraction.schema_valid ? "Validated provider response received" : "Provider response failed validation", `extraction:${extraction.extraction_id}`));
    events.push(timelineEvent(`structured:${extraction.extraction_id}`, "structured_evidence", extraction.schema_valid ? "COMPLETE" : "FAILED", extraction.finished_at, extraction.schema_valid ? "Structured evidence validated" : "Structured evidence unavailable", `extraction:${extraction.extraction_id}`));
  }
  for (const reassessment of reassessments.rows) {
    events.push(timelineEvent(`reassessment:${reassessment.reassessment_id}`, "governed_reassessment", "COMPLETE", reassessment.reassessed_at, "Governed reassessment completed", `reassessment:${reassessment.reassessment_id}`));
    events.push(timelineEvent(`outcome:${reassessment.reassessment_id}`, "simulated_outcome", "COMPLETE", reassessment.reassessed_at, `Simulated outcome: ${reassessment.outcome}`, `reassessment:${reassessment.reassessment_id}`));
    if (reassessment.guidance_payload) events.push(timelineEvent(`guidance:${reassessment.reassessment_id}`, "customer_guidance", "COMPLETE", reassessment.reassessed_at, "Persisted prevention guidance selected", `reassessment:${reassessment.reassessment_id}`));
  }
  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));

  return {
    schemaVersion: "fraud-investigation-view/1.0.0",
    generatedAt: new Date().toISOString(),
    paymentId: base.payment_id,
    transactionId: base.transaction_id,
    authoritativeVerdict: base.payment_status,
    stages,
    timeline: events,
  };
}
