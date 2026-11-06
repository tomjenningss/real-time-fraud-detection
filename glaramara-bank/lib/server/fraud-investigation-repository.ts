import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { z } from "zod";

import {
  EVIDENCE_SCHEMA_VERSION,
  type MinimalInvestigationContext,
} from "@/lib/fraud-intelligence/evidence";
import {
  buildFraudPreventionGuidance,
  GUIDANCE_CONTRACT_VERSION,
  type FraudPreventionGuidance,
} from "@/lib/fraud-intelligence/guidance.mjs";
import {
  extractFraudEvidence,
  fraudIntelligenceProvider,
} from "@/lib/fraud-intelligence/orchestrate-client";
import {
  allDefinitionSnapshot,
  conditionalQuestionIds,
  definitionSnapshot,
  initialQuestionIds,
  QUESTIONNAIRE_VERSION,
  questionnaireVersionSchema,
  type QuestionDefinition,
  validateAnswer,
} from "@/lib/fraud-intelligence/questionnaire";
import {
  reassessFraudEvidence,
  REASSESSMENT_POLICY_VERSION,
} from "@/lib/fraud-intelligence/policy.mjs";
import { ApiError } from "@/lib/server/api-errors";
import { query, withTransaction } from "@/lib/server/db";

const AGENT_NAME = "fraud_intelligence";
const AGENT_VERSION = "1.2.0";
const REQUIRED_EVIDENCE_KEYS = ["payment_recognition", "beneficiary_relationship", "payment_purpose"];

type InvestigationStatus =
  | "IN_PROGRESS"
  | "READY_FOR_EXTRACTION"
  | "EXTRACTING"
  | "NEEDS_CLARIFICATION"
  | "REASSESSED"
  | "FAILED";

type InvestigationRow = {
  customer_investigation_id: string;
  payment_id: string;
  transaction_id: string;
  customer_id: string;
  status: InvestigationStatus;
  questionnaire_version: string;
  risk_context_snapshot: {
    amount: number;
    currency: "GBP";
    beneficiaryPaymentCount: number;
    triggeredRuleIds: string[];
  };
  required_evidence_keys: string[];
  selected_question_ids: string[];
  question_definitions_snapshot: Record<string, QuestionDefinition>;
  clarification_question: (QuestionDefinition & { reason?: string }) | null;
  agent_invocation_count: number;
  questionnaire_completed_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

type AnswerRow = {
  question_id: string;
  question_version: string;
  question_source: "DEFINITION" | "AI_VALIDATED";
  answer_payload: { value: string };
  answered_at: Date;
};

type ReassessmentRow = {
  outcome: "CLEARED" | "REQUIRES_FURTHER_REVIEW" | "DECLINED"
    | "ADDITIONAL_VERIFICATION" | "REFER_TO_ANALYST";
  policy_version: string;
  reason_codes: string[];
  policy_trace: unknown[];
  guidance_contract_version: string | null;
  guidance_payload: FraudPreventionGuidance | null;
  reassessed_at: Date;
} | null;

export const investigationAnswerRequestSchema = z.object({
  questionId: z.string().min(1).max(96),
  answer: z.object({ value: z.string().trim().min(1).max(500) }),
});

async function appendEvent(
  client: PoolClient,
  investigationId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await client.query(`
    INSERT INTO customer_fraud_investigation_events
      (event_id, customer_investigation_id, event_type, event_payload)
    VALUES ($1, $2, $3, $4)
  `, [randomUUID(), investigationId, eventType, payload]);
}

async function loadInvestigation(customerId: string, paymentId: string) {
  const result = await query<InvestigationRow>(`
    SELECT investigation.customer_investigation_id, investigation.payment_id,
           attempt.transaction_id, investigation.customer_id, investigation.status,
           investigation.questionnaire_version, investigation.risk_context_snapshot,
           investigation.required_evidence_keys, investigation.selected_question_ids,
           investigation.question_definitions_snapshot, investigation.clarification_question,
           investigation.agent_invocation_count, investigation.questionnaire_completed_at,
           investigation.completed_at, investigation.updated_at
    FROM customer_fraud_investigations investigation
    JOIN banking_payment_attempts attempt ON attempt.payment_id = investigation.payment_id
    WHERE investigation.customer_id = $1 AND investigation.payment_id = $2
  `, [customerId, paymentId]);
  return result.rows[0] ?? null;
}

function questionFor(row: InvestigationRow, id: string): QuestionDefinition | null {
  if (row.clarification_question?.id === id) return row.clarification_question;
  return row.question_definitions_snapshot[id] ?? null;
}

async function investigationJson(row: InvestigationRow) {
  const [answersResult, reassessmentResult] = await Promise.all([
    query<AnswerRow>(`
      SELECT question_id, question_version, question_source, answer_payload, answered_at
      FROM customer_questionnaire_answers
      WHERE customer_investigation_id = $1
      ORDER BY answered_at, answer_id
    `, [row.customer_investigation_id]),
    query<Exclude<ReassessmentRow, null>>(`
      SELECT outcome, policy_version, reason_codes, policy_trace,
             guidance_contract_version, guidance_payload, reassessed_at
      FROM customer_fraud_reassessments
      WHERE customer_investigation_id = $1
      ORDER BY reassessed_at DESC, reassessment_id DESC
      LIMIT 1
    `, [row.customer_investigation_id]),
  ]);
  const answers = Object.fromEntries(answersResult.rows.map((answer) => [answer.question_id, {
    value: answer.answer_payload.value,
    answeredAt: answer.answered_at.toISOString(),
    source: answer.question_source,
  }]));
  const questions = row.selected_question_ids
    .map((id) => questionFor(row, id))
    .filter((item): item is QuestionDefinition => item !== null);
  const reassessment = reassessmentResult.rows[0] ?? null;
  const reassessmentLifecycle = row.status === "REASSESSED"
    ? "COMPLETED"
    : row.status === "FAILED"
      ? "FAILED"
      : row.status === "EXTRACTING"
        ? "PROCESSING"
        : "PENDING";
  return {
    id: row.customer_investigation_id,
    paymentId: row.payment_id,
    status: row.status,
    questionnaireVersion: row.questionnaire_version,
    questions,
    answers,
    currentQuestionId: questions.find((question) => !answers[question.id])?.id ?? null,
    answeredCount: Object.keys(answers).length,
    selectedQuestionCount: questions.length,
    agentInvocationCount: row.agent_invocation_count,
    canExtract: ["READY_FOR_EXTRACTION", "FAILED"].includes(row.status) && row.agent_invocation_count < 2,
    reassessmentLifecycle,
    lifecycleUpdatedAt: row.updated_at.toISOString(),
    resolution: reassessment ? {
      outcome: reassessment.outcome,
      policyVersion: reassessment.policy_version,
      reasonCodes: reassessment.reason_codes,
      policyTrace: reassessment.policy_trace,
      guidance: reassessment.guidance_payload,
      reassessedAt: reassessment.reassessed_at.toISOString(),
      simulated: true,
      ledgerEffect: "NONE" as const,
    } : null,
  };
}

export async function getFraudInvestigation(customerId: string, paymentId: string) {
  const row = await loadInvestigation(customerId, paymentId);
  return row ? investigationJson(row) : null;
}

export async function startFraudInvestigation(customerId: string, paymentId: string) {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `glaramara-investigation:${paymentId}`,
    ]);
    const existing = await client.query<{ customer_investigation_id: string }>(`
      SELECT customer_investigation_id FROM customer_fraud_investigations
      WHERE payment_id = $1 AND customer_id = $2
    `, [paymentId, customerId]);
    if (existing.rows[0]) return;

    const source = await client.query<{
      transaction_id: string;
      amount: string;
      currency: "GBP";
      decision_id: string;
      payment_verdict: string;
      decision_payload: { triggered_rule_ids?: string[] };
      investigation_id: string;
      beneficiary_payment_count: string;
    }>(`
      SELECT attempt.transaction_id, attempt.amount, attempt.currency,
             decision.decision_id, decision.payment_verdict, decision.decision_payload,
             fraud_investigation.investigation_id,
             (SELECT count(*)::text FROM banking_transactions booked
              WHERE booked.customer_id = attempt.customer_id
                AND booked.beneficiary_id = attempt.beneficiary_id) AS beneficiary_payment_count
      FROM banking_payment_attempts attempt
      JOIN payment_decisions decision ON decision.transaction_id = attempt.transaction_id
      JOIN investigations fraud_investigation ON fraud_investigation.decision_id = decision.decision_id
      WHERE attempt.payment_id = $1 AND attempt.customer_id = $2
      FOR SHARE OF attempt, decision, fraud_investigation
    `, [paymentId, customerId]);
    const payment = source.rows[0];
    if (!payment) throw new ApiError(409, "INVESTIGATION_NOT_READY", "The fraud challenge is not ready yet.");
    if (payment.payment_verdict !== "CHALLENGED") {
      throw new ApiError(409, "PAYMENT_NOT_CHALLENGED", "Only challenged payments can start this check.");
    }
    const triggeredRuleIds = payment.decision_payload.triggered_rule_ids ?? [];
    const beneficiaryPaymentCount = Number(payment.beneficiary_payment_count);
    const selectedQuestionIds = initialQuestionIds({ triggeredRuleIds, beneficiaryPaymentCount });
    const investigationId = randomUUID();
    await client.query(`
      INSERT INTO customer_fraud_investigations
        (customer_investigation_id, fraud_investigation_id, payment_id, customer_id,
         original_decision_id, original_payment_verdict, questionnaire_version,
         risk_context_snapshot, required_evidence_keys, selected_question_ids,
         question_definitions_snapshot)
      VALUES ($1, $2, $3, $4, $5, 'CHALLENGED', $6, $7, $8, $9, $10)
    `, [
      investigationId,
      payment.investigation_id,
      paymentId,
      customerId,
      payment.decision_id,
      QUESTIONNAIRE_VERSION,
      {
        amount: Number(payment.amount),
        currency: payment.currency,
        beneficiaryPaymentCount,
        triggeredRuleIds,
      },
      JSON.stringify(REQUIRED_EVIDENCE_KEYS),
      JSON.stringify(selectedQuestionIds),
      allDefinitionSnapshot(),
    ]);
    await appendEvent(client, investigationId, "STARTED", {
      questionnaireVersion: QUESTIONNAIRE_VERSION,
      selectedQuestionIds,
    });
  });
  return getFraudInvestigation(customerId, paymentId);
}

export async function answerFraudQuestion(
  customerId: string,
  paymentId: string,
  idempotencyKey: string,
  input: z.infer<typeof investigationAnswerRequestSchema>,
) {
  await withTransaction(async (client) => {
    const result = await client.query<InvestigationRow>(`
      SELECT investigation.*, attempt.transaction_id
      FROM customer_fraud_investigations investigation
      JOIN banking_payment_attempts attempt ON attempt.payment_id = investigation.payment_id
      WHERE investigation.customer_id = $1 AND investigation.payment_id = $2
      FOR UPDATE OF investigation
    `, [customerId, paymentId]);
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Start the security check first.");
    const question = questionFor(row, input.questionId);
    if (!question || !row.selected_question_ids.includes(input.questionId)) {
      throw new ApiError(400, "QUESTION_NOT_SELECTED", "That question is not part of this security check.");
    }
    const answer = validateAnswer(question, input.answer);
    const replay = await client.query<AnswerRow & { idempotency_key: string }>(`
      SELECT question_id, question_version, question_source, answer_payload, answered_at, idempotency_key
      FROM customer_questionnaire_answers
      WHERE customer_investigation_id = $1
        AND (idempotency_key = $2 OR question_id = $3)
      LIMIT 1
    `, [row.customer_investigation_id, idempotencyKey, input.questionId]);
    if (replay.rows[0]) {
      if (replay.rows[0].question_id === input.questionId
          && replay.rows[0].answer_payload.value === answer.value) return;
      throw new ApiError(409, "ANSWER_CONFLICT", "This question or idempotency key was already used.");
    }
    if (!["IN_PROGRESS", "NEEDS_CLARIFICATION"].includes(row.status)) {
      throw new ApiError(409, "INVESTIGATION_NOT_ANSWERABLE", "This security check is not accepting answers.");
    }
    const source = row.clarification_question?.id === input.questionId ? "AI_VALIDATED" : "DEFINITION";
    await client.query(`
      INSERT INTO customer_questionnaire_answers
        (answer_id, customer_investigation_id, question_id, question_version,
         question_source, answer_payload, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      randomUUID(),
      row.customer_investigation_id,
      input.questionId,
      question.version,
      source,
      answer,
      idempotencyKey,
    ]);
    await appendEvent(client, row.customer_investigation_id, "ANSWER_RECORDED", {
      questionId: input.questionId,
      questionSource: source,
    });

    const currentAnswers = await client.query<{ question_id: string; answer_payload: { value: string } }>(`
      SELECT question_id, answer_payload FROM customer_questionnaire_answers
      WHERE customer_investigation_id = $1
    `, [row.customer_investigation_id]);
    const answerValues = Object.fromEntries(currentAnswers.rows.map((item) => [
      item.question_id,
      item.answer_payload.value,
    ]));
    const selected = [...new Set([
      ...row.selected_question_ids,
      ...conditionalQuestionIds(answerValues),
    ])];
    const ready = selected.every((questionId) => questionId in answerValues);
    await client.query(`
      UPDATE customer_fraud_investigations
      SET selected_question_ids = $2,
          status = CASE
            WHEN $3 THEN 'READY_FOR_EXTRACTION'::customer_investigation_status
            ELSE 'IN_PROGRESS'::customer_investigation_status
          END,
          questionnaire_completed_at = CASE
            WHEN $3 THEN COALESCE(questionnaire_completed_at, now())
            ELSE questionnaire_completed_at
          END
      WHERE customer_investigation_id = $1
    `, [row.customer_investigation_id, JSON.stringify(selected), ready]);
    if (ready) {
      await appendEvent(client, row.customer_investigation_id, "QUESTIONNAIRE_COMPLETED", {
        answeredQuestionCount: currentAnswers.rowCount,
      });
    }
  });
  return getFraudInvestigation(customerId, paymentId);
}

function minimalContext(row: InvestigationRow, answers: AnswerRow[]): MinimalInvestigationContext {
  const questions = row.selected_question_ids
    .map((id) => questionFor(row, id))
    .filter((item): item is QuestionDefinition => item !== null)
    .map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options?.map((option) => option.value),
    }));
  return {
    schemaVersion: "fraud-intelligence-request/1.0.0",
    questionnaireVersion: row.questionnaire_version,
    transactionRef: row.transaction_id,
    payment: {
      amount: row.risk_context_snapshot.amount,
      currency: row.risk_context_snapshot.currency,
      beneficiaryPreviouslyPaid: row.risk_context_snapshot.beneficiaryPaymentCount > 0,
    },
    deterministicSignals: row.risk_context_snapshot.triggeredRuleIds,
    requiredEvidenceKeys: row.required_evidence_keys,
    questions,
    answers: answers.map((answer) => ({
      questionId: answer.question_id,
      value: answer.answer_payload.value,
      provenance: "CUSTOMER" as const,
    })),
  };
}

export async function executeFraudIntelligence(customerId: string, paymentId: string) {
  const claimed = await withTransaction(async (client) => {
    const result = await client.query<InvestigationRow>(`
      SELECT investigation.*, attempt.transaction_id
      FROM customer_fraud_investigations investigation
      JOIN banking_payment_attempts attempt ON attempt.payment_id = investigation.payment_id
      WHERE investigation.customer_id = $1 AND investigation.payment_id = $2
      FOR UPDATE OF investigation
    `, [customerId, paymentId]);
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Start the security check first.");

    const configuredTimeoutMs = Number(process.env.FRAUD_INTELLIGENCE_TIMEOUT_MS ?? "45000");
    const recoveryAfterMs = (Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : 45_000) + 15_000;
    const processingIsStale = row.status === "EXTRACTING"
      && Date.now() - row.updated_at.getTime() >= recoveryAfterMs;
    if (row.status === "EXTRACTING" && processingIsStale && row.agent_invocation_count >= 2) {
      await client.query(`
        UPDATE customer_fraud_investigations
        SET status = 'FAILED', completed_at = now()
        WHERE customer_investigation_id = $1
      `, [row.customer_investigation_id]);
      await appendEvent(client, row.customer_investigation_id, "FAILED", {
        errorType: "PROCESSING_TIMEOUT",
      });
      return { kind: "existing" as const };
    }
    const canClaim = ["READY_FOR_EXTRACTION", "FAILED"].includes(row.status)
      || processingIsStale;
    if (!canClaim || row.agent_invocation_count >= 2) {
      return { kind: "existing" as const };
    }
    const answers = await client.query<AnswerRow>(`
      SELECT question_id, question_version, question_source, answer_payload, answered_at
      FROM customer_questionnaire_answers
      WHERE customer_investigation_id = $1
      ORDER BY answered_at, answer_id
    `, [row.customer_investigation_id]);
    const invocationNumber = row.agent_invocation_count + 1;
    await client.query(`
      UPDATE customer_fraud_investigations
      SET status = 'EXTRACTING', agent_invocation_count = $2, completed_at = NULL
      WHERE customer_investigation_id = $1
    `, [row.customer_investigation_id, invocationNumber]);
    await appendEvent(client, row.customer_investigation_id, "EXTRACTION_STARTED", { invocationNumber });
    return {
      kind: "claimed" as const,
      row,
      answers: answers.rows,
      invocationNumber,
      context: minimalContext(row, answers.rows),
    };
  });

  if (claimed.kind === "existing") {
    const state = await getFraudInvestigation(customerId, paymentId);
    if (!state) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Security check not found.");
    return state;
  }

  const requestSha256 = createHash("sha256")
    .update(JSON.stringify(claimed.context))
    .digest("hex");
  const startedAt = new Date();
  try {
    const result = await extractFraudEvidence(claimed.context);
    const finishedAt = new Date();
    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO fraud_intelligence_extractions
          (extraction_id, customer_investigation_id, invocation_number, request_sha256,
           agent_name, agent_version, provider, model, evidence_schema_version,
           response_payload, schema_valid, latency_ms, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, $13)
      `, [
        randomUUID(), claimed.row.customer_investigation_id, claimed.invocationNumber,
        requestSha256, AGENT_NAME, AGENT_VERSION, result.provider, result.model,
        EVIDENCE_SCHEMA_VERSION, result.evidence, result.latencyMs, startedAt, finishedAt,
      ]);

      if (result.evidence.clarificationQuestion.needed && claimed.invocationNumber === 1) {
        const clarification: QuestionDefinition & { reason: string } = {
          id: result.evidence.clarificationQuestion.id,
          version: questionnaireVersionSchema.parse(claimed.row.questionnaire_version),
          prompt: result.evidence.clarificationQuestion.prompt,
          kind: "SINGLE_CHOICE",
          required: true,
          options: result.evidence.clarificationQuestion.options.map((option) => ({
            value: option,
            label: option,
          })),
          reason: result.evidence.clarificationQuestion.reason,
        };
        await client.query(`
          UPDATE customer_fraud_investigations
          SET status = 'NEEDS_CLARIFICATION', clarification_question = $2,
              selected_question_ids = selected_question_ids || jsonb_build_array($3::text)
          WHERE customer_investigation_id = $1
        `, [claimed.row.customer_investigation_id, clarification, clarification.id]);
        await appendEvent(client, claimed.row.customer_investigation_id, "CLARIFICATION_REQUESTED", {
          questionId: clarification.id,
          invocationNumber: claimed.invocationNumber,
        });
        return;
      }

      const policy = claimed.invocationNumber > 1 && result.evidence.clarificationQuestion.needed
        ? {
            outcome: "REFER_TO_ANALYST" as const,
            reasonCodes: ["REPEATED_CLARIFICATION_NOT_ALLOWED"],
            policyTrace: [{
              ruleId: "CER-REFER-REPEATED-CLARIFICATION",
              policyVersion: REASSESSMENT_POLICY_VERSION,
              outcome: "REFER_TO_ANALYST",
              summary: "A second AI-generated clarification is not permitted.",
              conditions: [],
              sourceQuestionIds: [],
            }],
          }
        : reassessFraudEvidence(result.evidence);
      const customerExplanation = claimed.answers.find(
        (answer) => ["investment_reason", "payment_circumstances"].includes(answer.question_id),
      )?.answer_payload.value ?? null;
      const guidance = buildFraudPreventionGuidance({
        evidence: result.evidence,
        reassessment: policy,
        customerExplanation,
        context: claimed.context.payment,
      });
      const extraction = await client.query<{ extraction_id: string }>(`
        SELECT extraction_id FROM fraud_intelligence_extractions
        WHERE customer_investigation_id = $1 AND invocation_number = $2
      `, [claimed.row.customer_investigation_id, claimed.invocationNumber]);
      await client.query(`
        INSERT INTO customer_fraud_reassessments
          (reassessment_id, customer_investigation_id, extraction_id, policy_version,
           outcome, reason_codes, evidence_snapshot, policy_trace, original_payment_verdict,
           guidance_contract_version, guidance_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CHALLENGED', $9, $10)
      `, [
        randomUUID(), claimed.row.customer_investigation_id, extraction.rows[0].extraction_id,
        REASSESSMENT_POLICY_VERSION, policy.outcome, JSON.stringify(policy.reasonCodes), result.evidence,
        JSON.stringify(policy.policyTrace), GUIDANCE_CONTRACT_VERSION, guidance,
      ]);
      await client.query(`
        UPDATE customer_fraud_investigations
        SET status = 'REASSESSED', completed_at = now()
        WHERE customer_investigation_id = $1
      `, [claimed.row.customer_investigation_id]);
      await appendEvent(client, claimed.row.customer_investigation_id, "REASSESSED", {
        outcome: policy.outcome,
        policyVersion: REASSESSMENT_POLICY_VERSION,
      });
    });
  } catch (error) {
    const finishedAt = new Date();
    const latencyMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const errorType = error instanceof z.ZodError ? "INVALID_SCHEMA" : error instanceof Error
      ? error.name.toUpperCase() : "UNKNOWN";
    await withTransaction(async (client) => {
      const extractionId = randomUUID();
      const failedPolicy = {
        outcome: "REFER_TO_ANALYST" as const,
        reasonCodes: [`AGENT_${errorType}`],
      };
      const customerExplanation = claimed.answers.find(
        (answer) => answer.question_id === "payment_circumstances",
      )?.answer_payload.value ?? null;
      const guidance = buildFraudPreventionGuidance({
        evidence: null,
        reassessment: failedPolicy,
        customerExplanation,
        context: claimed.context.payment,
      });
      await client.query(`
        INSERT INTO fraud_intelligence_extractions
          (extraction_id, customer_investigation_id, invocation_number, request_sha256,
           agent_name, agent_version, provider, model, evidence_schema_version,
           response_payload, schema_valid, latency_ms, error_type, started_at, finished_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, false, $10, $11, $12, $13)
      `, [
        extractionId, claimed.row.customer_investigation_id, claimed.invocationNumber,
        requestSha256, AGENT_NAME, AGENT_VERSION,
        fraudIntelligenceProvider() === "orchestrate" ? "watsonx-orchestrate-rest" : "disabled",
        process.env.FRAUD_INTELLIGENCE_MODEL ?? "unavailable",
        EVIDENCE_SCHEMA_VERSION, latencyMs, errorType, startedAt, finishedAt,
      ]);
      await client.query(`
        INSERT INTO customer_fraud_reassessments
          (reassessment_id, customer_investigation_id, extraction_id, policy_version,
           outcome, reason_codes, evidence_snapshot, policy_trace, original_payment_verdict,
           guidance_contract_version, guidance_payload)
        VALUES ($1, $2, $3, $4, 'REFER_TO_ANALYST', $5, $6, $7, 'CHALLENGED', $8, $9)
      `, [
        randomUUID(), claimed.row.customer_investigation_id, extractionId,
        REASSESSMENT_POLICY_VERSION, JSON.stringify([`AGENT_${errorType}`]), {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          failure: errorType,
        }, JSON.stringify([{
          ruleId: "CER-REFER-EXTRACTION-UNAVAILABLE",
          policyVersion: REASSESSMENT_POLICY_VERSION,
          outcome: "REFER_TO_ANALYST",
          summary: "Validated Fraud Intelligence evidence was unavailable.",
          conditions: [{ condition: "schema-valid evidence is required", actual: errorType, findingIds: [] }],
          sourceQuestionIds: [],
        }]), GUIDANCE_CONTRACT_VERSION, guidance,
      ]);
      await client.query(`
        UPDATE customer_fraud_investigations
        SET status = 'FAILED', completed_at = now()
        WHERE customer_investigation_id = $1
      `, [claimed.row.customer_investigation_id]);
      await appendEvent(client, claimed.row.customer_investigation_id, "FAILED", {
        errorType,
        conservativeOutcome: "REFER_TO_ANALYST",
      });
    });
  }
  const state = await getFraudInvestigation(customerId, paymentId);
  if (!state) throw new ApiError(404, "INVESTIGATION_NOT_FOUND", "Security check not found.");
  return state;
}
