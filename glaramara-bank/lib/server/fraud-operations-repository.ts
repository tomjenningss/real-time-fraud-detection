import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  featureCatalogue,
  FraudRuleDiscoveryEvidenceReferenceError,
  PROPOSAL_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  ruleFingerprint,
  sha256,
  validateEvidenceReferences,
} from "@/lib/fraud-rule-discovery/contracts";
import {
  backtest,
  EVALUATOR_VERSION,
  type HistoricalRow,
  SEMANTICS_NOTE,
} from "@/lib/fraud-rule-discovery/evaluator";
import {
  discoverRule,
  FraudRuleDiscoveryDiagnosticError,
  type DiscoveryDiagnostic,
} from "@/lib/fraud-rule-discovery/orchestrate-client";
import { ApiError, isPostgresError } from "@/lib/server/api-errors";
import { query, withTransaction } from "@/lib/server/db";

type WaveRow = {
  wave_id: string;
  dataset_schema_version: string;
  generator_version: string;
  seed: string;
  period_start: Date;
  period_end: Date;
  row_count: number;
  discovery_count: number;
  evaluation_count: number;
  content_sha256: string;
};

type DatasetRow = {
  dataset_id: string;
  environment_id: string;
  generator_version: string;
  seed: string;
  requested_transaction_count: number;
  actual_transaction_count: number | null;
  fraud_scenario_id: string;
  status: "PENDING" | "GENERATING" | "READY" | "FAILED";
  content_sha256: string | null;
  requested_at: Date;
  generation_started_at: Date | null;
  generated_at: Date | null;
  failure_code: string | null;
  active: boolean;
};

const FRAUD_LAB_ENVIRONMENT = "glaramara-local";

function fallbackDiscoveryDiagnostic(): DiscoveryDiagnostic {
  return {
    agentId: process.env.FRAUD_RULE_DISCOVERY_AGENT_ID?.trim() || null,
    agentVersion: "1.0.0",
    provider: process.env.FRAUD_RULE_DISCOVERY_PROVIDER?.trim() || "disabled",
    model: process.env.FRAUD_RULE_DISCOVERY_MODEL?.trim() || "unavailable",
    contractVersion: PROPOSAL_SCHEMA_VERSION,
    validationStage: "INVOCATION",
    rawCompletion: null,
    extractedProposal: null,
    validationIssues: [],
    evidenceReferenceFailures: null,
    supportingEvidenceRefsState: "NOT_EXTRACTED",
    latencyMs: 0,
  };
}

async function persistDiscoveryDiagnostic(runId: string, diagnostic: DiscoveryDiagnostic): Promise<void> {
  await query(`
    INSERT INTO fraud_discovery_diagnostics
      (diagnostic_id, run_id, agent_id, agent_version, provider, model, contract_version,
       validation_stage, raw_completion, extracted_proposal, validation_issues,
       evidence_reference_failures, supporting_evidence_refs_state, latency_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    randomUUID(), runId, diagnostic.agentId, diagnostic.agentVersion, diagnostic.provider,
    diagnostic.model, diagnostic.contractVersion, diagnostic.validationStage,
    diagnostic.rawCompletion === null ? null : JSON.stringify(diagnostic.rawCompletion),
    diagnostic.extractedProposal === null ? null : JSON.stringify(diagnostic.extractedProposal),
    JSON.stringify(diagnostic.validationIssues),
    diagnostic.evidenceReferenceFailures === null ? null : JSON.stringify(diagnostic.evidenceReferenceFailures),
    diagnostic.supportingEvidenceRefsState, diagnostic.latencyMs,
  ]);
}

function mapDataset(row: DatasetRow) {
  return {
    id: row.dataset_id,
    environmentId: row.environment_id,
    generatorVersion: row.generator_version,
    seed: row.seed,
    requestedTransactionCount: row.requested_transaction_count,
    actualTransactionCount: row.actual_transaction_count,
    fraudScenarioId: row.fraud_scenario_id,
    status: row.status,
    contentSha256: row.content_sha256,
    requestedAt: row.requested_at.toISOString(),
    generationStartedAt: row.generation_started_at?.toISOString() ?? null,
    generatedAt: row.generated_at?.toISOString() ?? null,
    failureCode: row.failure_code,
    active: row.active,
  };
}

const datasetSelection = `
  SELECT dataset.*, (active.dataset_id IS NOT NULL) AS active
  FROM fraud_lab_datasets dataset
  LEFT JOIN fraud_lab_active_datasets active
    ON active.environment_id = dataset.environment_id AND active.dataset_id = dataset.dataset_id
  WHERE dataset.environment_id = $1`;

export async function listFraudLabDatasets() {
  const result = await query<DatasetRow>(`${datasetSelection} ORDER BY dataset.requested_at DESC`, [FRAUD_LAB_ENVIRONMENT]);
  return result.rows.map(mapDataset);
}

export async function getFraudLabDataset(datasetId: string) {
  const result = await query<DatasetRow>(`${datasetSelection} AND dataset.dataset_id = $2`, [FRAUD_LAB_ENVIRONMENT, datasetId]);
  if (!result.rows[0]) throw new ApiError(404, "FRAUD_LAB_DATASET_NOT_FOUND", "That Fraud Lab dataset was not found.");
  return mapDataset(result.rows[0]);
}

export const datasetGenerationRequestSchema = z.object({
  transactionCount: z.union([z.literal(8_000), z.literal(10_000), z.literal(20_000)]),
}).strict();

export async function requestFraudLabDataset(
  analystId: string,
  idempotencyKey: string,
  input: z.infer<typeof datasetGenerationRequestSchema>,
) {
  let datasetId = "";
  try {
    datasetId = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fraud-lab-generation:${FRAUD_LAB_ENVIRONMENT}`]);
      const replay = await client.query<{ dataset_id: string; requested_transaction_count: number }>(
        `SELECT dataset_id::text, requested_transaction_count FROM fraud_lab_datasets
         WHERE requested_by = $1 AND idempotency_key = $2`,
        [analystId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].requested_transaction_count !== input.transactionCount) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "That idempotency key belongs to a different generation request.");
        }
        return replay.rows[0].dataset_id;
      }
      const running = await client.query(
        `SELECT 1 FROM fraud_lab_datasets WHERE environment_id = $1 AND status IN ('PENDING', 'GENERATING')`,
        [FRAUD_LAB_ENVIRONMENT],
      );
      if (running.rowCount) {
        throw new ApiError(409, "FRAUD_LAB_GENERATION_IN_PROGRESS", "Another Fraud Lab dataset is already being generated.");
      }
      const id = randomUUID();
      const seed = BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`).toString();
      await client.query(
        `INSERT INTO fraud_lab_datasets
           (dataset_id, environment_id, generator_version, seed, requested_transaction_count,
            fraud_scenario_id, status, requested_by, idempotency_key)
         VALUES ($1, $2, 'fraud-lab-generator/1.1.0', $3, $4,
                 'multi_new_beneficiary', 'PENDING', $5, $6)`,
        [id, FRAUD_LAB_ENVIRONMENT, seed, input.transactionCount, analystId, idempotencyKey],
      );
      return id;
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isPostgresError(error, "23505")) {
      throw new ApiError(409, "FRAUD_LAB_GENERATION_CONFLICT", "The generation request conflicted with another request.");
    }
    throw error;
  }
  return getFraudLabDataset(datasetId);
}

export const datasetActivationRequestSchema = z.object({
  confirmation: z.literal("ACTIVATE"),
}).strict();

export async function activateFraudLabDataset(datasetId: string, analystId: string) {
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fraud-lab-activation:${FRAUD_LAB_ENVIRONMENT}`]);
    const dataset = await client.query<{ status: string }>(
      `SELECT status FROM fraud_lab_datasets WHERE dataset_id = $1 AND environment_id = $2 FOR SHARE`,
      [datasetId, FRAUD_LAB_ENVIRONMENT],
    );
    if (!dataset.rows[0]) throw new ApiError(404, "FRAUD_LAB_DATASET_NOT_FOUND", "That Fraud Lab dataset was not found.");
    if (dataset.rows[0].status !== "READY") {
      throw new ApiError(409, "FRAUD_LAB_DATASET_NOT_READY", "Only a completed Fraud Lab dataset can be activated.");
    }
    const current = await client.query<{ dataset_id: string }>(
      `SELECT dataset_id::text FROM fraud_lab_active_datasets WHERE environment_id = $1 FOR UPDATE`,
      [FRAUD_LAB_ENVIRONMENT],
    );
    if (current.rows[0]?.dataset_id === datasetId) return;
    await client.query(
      `INSERT INTO fraud_lab_active_datasets (environment_id, dataset_id, activated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (environment_id) DO UPDATE
       SET dataset_id = EXCLUDED.dataset_id, activated_by = EXCLUDED.activated_by, activated_at = now()`,
      [FRAUD_LAB_ENVIRONMENT, datasetId, analystId],
    );
    await client.query(
      `INSERT INTO fraud_lab_dataset_activation_events
         (activation_id, environment_id, dataset_id, previous_dataset_id, activated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), FRAUD_LAB_ENVIRONMENT, datasetId, current.rows[0]?.dataset_id ?? null, analystId],
    );
  });
  return getFraudLabDataset(datasetId);
}

type DiscoveryRow = HistoricalRow & {
  baseline_action: "APPROVED" | "CHALLENGED" | "BLOCKED";
  beneficiary_payment_count_before: number;
  transactions_1m: number;
  transactions_2m: number;
  transactions_10m: number;
  distinct_merchants_2m: number;
  total_amount_2m: string;
  distinct_new_beneficiaries_24h: number;
  new_beneficiary_payments_24h: number;
  new_beneficiary_total_24h: string;
  beneficiary_distinct_customers_24h: number;
};

const cohortDefinitions = [
  ...[100, 500, 1_000, 2_500, 5_000].map((threshold) => ({ id: "amount_gbp", column: "amount", operator: "GTE", threshold })),
  { id: "beneficiary_payment_count_before", column: "beneficiary_payment_count_before", operator: "EQ", threshold: 0 },
  ...[2, 3, 4, 5].map((threshold) => ({ id: "customer_distinct_new_beneficiary_count", column: "distinct_new_beneficiaries_24h", operator: "GTE", threshold })),
  ...[2, 3, 4, 5].map((threshold) => ({ id: "customer_new_beneficiary_payment_count", column: "new_beneficiary_payments_24h", operator: "GTE", threshold })),
  ...[500, 1_500, 2_500, 5_000].map((threshold) => ({ id: "customer_new_beneficiary_total_gbp", column: "new_beneficiary_total_24h", operator: "GTE", threshold })),
  ...[3, 5].map((threshold) => ({ id: "customer_transaction_count", column: "transactions_2m", operator: "GTE", threshold })),
  ...[2, 4].map((threshold) => ({ id: "customer_distinct_merchant_count", column: "distinct_merchants_2m", operator: "GTE", threshold })),
  ...[2, 3, 5, 10].map((threshold) => ({ id: "beneficiary_distinct_customers", column: "beneficiary_distinct_customers_24h", operator: "GTE", threshold })),
] as const;

function cohortMatches(row: DiscoveryRow, column: string, operator: string, threshold: number): boolean {
  const value = Number(row[column as keyof DiscoveryRow]);
  return operator === "EQ" ? value === threshold : value >= threshold;
}

async function buildDiscoveryReport(runId: string, waveIds: string[], snapshotSha256: string) {
  const [transactions, prior] = await Promise.all([
    query<DiscoveryRow>(`
      SELECT transaction_id::text, event_time, customer_id::text, beneficiary_id::text,
             merchant_id::text, amount::text, ground_truth_fraud, baseline_action,
             beneficiary_payment_count_before, transactions_1m, transactions_2m,
             transactions_10m, distinct_merchants_2m, total_amount_2m::text,
             distinct_new_beneficiaries_24h, new_beneficiary_payments_24h,
             new_beneficiary_total_24h::text, beneficiary_distinct_customers_24h
      FROM fraud_lab_transactions
      WHERE wave_id = ANY($1::text[]) AND partition = 'DISCOVERY'
      ORDER BY event_time, transaction_id
    `, [waveIds]),
    query<{
      candidate_id: string; rule_fingerprint: string; rule_name: string; proposal_payload: unknown; status: string;
    }>(`
      SELECT candidate.candidate_id::text, candidate.rule_fingerprint, candidate.rule_name,
             candidate.proposal_payload, status.status
      FROM fraud_rule_candidates candidate
      JOIN fraud_rule_candidate_status status ON status.candidate_id = candidate.candidate_id
      ORDER BY candidate.created_at DESC LIMIT 20
    `),
  ]);
  const rows = transactions.rows;
  const cohorts = cohortDefinitions.map((definition) => {
    const matching = rows.filter((row) => cohortMatches(row, definition.column, definition.operator, definition.threshold));
    const fraud = matching.filter((row) => row.ground_truth_fraud);
    return {
      evidenceRef: `cohort:${definition.id}:${definition.operator}:${definition.threshold}`,
      featureId: definition.id,
      operator: definition.operator,
      threshold: definition.threshold,
      transactionCount: matching.length,
      fraudLabelCount: fraud.length,
      genuineLabelCount: matching.length - fraud.length,
      baselineMissedFraudCount: fraud.filter((row) => row.baseline_action === "APPROVED").length,
      baselineDetectedCount: matching.filter((row) => row.baseline_action !== "APPROVED").length,
    };
  });
  const exampleRows = [
    ...rows.filter((row) => row.ground_truth_fraud && row.baseline_action === "APPROVED")
      .sort((left, right) => right.distinct_new_beneficiaries_24h - left.distinct_new_beneficiaries_24h).slice(0, 8),
    ...rows.filter((row) => !row.ground_truth_fraud && row.distinct_new_beneficiaries_24h >= 2)
      .sort((left, right) => right.distinct_new_beneficiaries_24h - left.distinct_new_beneficiaries_24h).slice(0, 8),
  ];
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    snapshotSha256,
    dataBoundary: "DISCOVERY_ONLY" as const,
    controlContext: {
      authoritativePolicyVersion: "fast-path-policy/1.1.0",
      activeDeterministicControls: [
        { signal: "HIGH_VELOCITY", action: "CHALLENGED", ruleId: "FP-CHALLENGE-VELOCITY" },
        {
          signal: "MERCHANT_HOPPING",
          action: "CHALLENGED",
          ruleId: "FP-CHALLENGE-HOPPING",
          precedence: "HIGH_VELOCITY plus MERCHANT_HOPPING is BLOCKED by FP-BLOCK-VELOCITY-HOPPING",
        },
        {
          signal: "NEW_BENEFICIARY_HIGH_VALUE",
          action: "CHALLENGED",
          ruleId: "FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0",
        },
      ],
      priorCandidateBoundary:
        "Every entry in previousProposals is a proposed historical candidate, not an active or deployed control. APPROVED_FOR_IMPLEMENTATION means pending engineering implementation only.",
    },
    summary: {
      transactionCount: rows.length,
      fraudLabelCount: rows.filter((row) => row.ground_truth_fraud).length,
      genuineLabelCount: rows.filter((row) => !row.ground_truth_fraud).length,
      baselineDetectedFraudCount: rows.filter((row) => row.ground_truth_fraud && row.baseline_action !== "APPROVED").length,
      baselineMissedFraudCount: rows.filter((row) => row.ground_truth_fraud && row.baseline_action === "APPROVED").length,
      baselinePolicyVersion: "fast-path-policy/1.1.0",
    },
    featureCatalogue,
    cohorts,
    examples: exampleRows.map((row, index) => ({
      evidenceRef: `example:discovery:${index + 1}`,
      transactionRef: row.transaction_id,
      amountGbp: Number(row.amount),
      fraudLabel: row.ground_truth_fraud,
      baselineAction: row.baseline_action,
      beneficiaryPaymentCountBefore: row.beneficiary_payment_count_before,
      transactions2m: row.transactions_2m,
      distinctMerchants2m: row.distinct_merchants_2m,
      distinctNewBeneficiaries24h: row.distinct_new_beneficiaries_24h,
      newBeneficiaryPayments24h: row.new_beneficiary_payments_24h,
      newBeneficiaryTotalGbp24h: Number(row.new_beneficiary_total_24h),
      beneficiaryDistinctCustomers24h: row.beneficiary_distinct_customers_24h,
    })),
    previousProposals: prior.rows.map((candidate) => {
      const payload = candidate.proposal_payload as { conditions?: unknown; action?: unknown };
      return {
        candidateId: candidate.candidate_id,
        fingerprint: candidate.rule_fingerprint,
        name: candidate.rule_name,
        action: payload.action,
        conditions: payload.conditions,
        status: candidate.status,
        deploymentStatus: "NOT_DEPLOYED" as const,
        relationshipToActiveControls: "CANDIDATE_ONLY" as const,
      };
    }),
  };
}

export async function getFraudOperationsDashboard() {
  const [waves, totals, runs, datasets] = await Promise.all([
    query<WaveRow>(`SELECT wave.* FROM fraud_lab_active_datasets active
      JOIN fraud_lab_dataset_waves member ON member.dataset_id = active.dataset_id
      JOIN fraud_lab_waves wave ON wave.wave_id = member.wave_id
      WHERE active.environment_id = $1 ORDER BY member.ordinal`, [FRAUD_LAB_ENVIRONMENT]),
    query<{ total: string; fraud: string; detected: string }>(`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE ground_truth_fraud)::text AS fraud,
             count(*) FILTER (WHERE ground_truth_fraud AND baseline_action <> 'APPROVED')::text AS detected
      FROM fraud_lab_active_datasets active
      JOIN fraud_lab_dataset_waves member ON member.dataset_id = active.dataset_id
      JOIN fraud_lab_transactions transaction_row ON transaction_row.wave_id = member.wave_id
      WHERE active.environment_id = $1
    `, [FRAUD_LAB_ENVIRONMENT]),
    query<{ run_id: string; status: string; snapshot_row_count: number; started_at: Date; finished_at: Date | null; candidate_id: string | null; rule_name: string | null; candidate_status: string | null }>(`
      SELECT run.run_id::text, run.status, run.snapshot_row_count, run.started_at, run.finished_at,
             candidate.candidate_id::text, candidate.rule_name, candidate_status.status AS candidate_status
      FROM fraud_discovery_runs run
      LEFT JOIN fraud_rule_candidates candidate ON candidate.run_id = run.run_id
      LEFT JOIN fraud_rule_candidate_status candidate_status ON candidate_status.candidate_id = candidate.candidate_id
      ORDER BY run.started_at DESC LIMIT 20
    `),
    listFraudLabDatasets(),
  ]);
  const total = Number(totals.rows[0]?.total ?? 0);
  const fraud = Number(totals.rows[0]?.fraud ?? 0);
  const detected = Number(totals.rows[0]?.detected ?? 0);
  return {
    synthetic: true,
    activeDatasetId: datasets.find((dataset) => dataset.active)?.id ?? null,
    datasets,
    dataset: { totalTransactions: total, fraudLabelled: fraud, baselineFraudDetected: detected, baselineCoverage: fraud ? detected / fraud : 0 },
    waves: waves.rows.map((wave) => ({
      id: wave.wave_id, schemaVersion: wave.dataset_schema_version, generatorVersion: wave.generator_version,
      seed: Number(wave.seed), periodStart: wave.period_start.toISOString(), periodEnd: wave.period_end.toISOString(),
      rowCount: wave.row_count, discoveryCount: wave.discovery_count, evaluationCount: wave.evaluation_count,
      contentSha256: wave.content_sha256,
    })),
    runs: runs.rows.map((run) => ({
      id: run.run_id, status: run.status, snapshotRowCount: run.snapshot_row_count,
      startedAt: run.started_at.toISOString(), finishedAt: run.finished_at?.toISOString() ?? null,
      candidateId: run.candidate_id, ruleName: run.rule_name, candidateStatus: run.candidate_status,
    })),
  };
}

export async function getDiscoveryRun(runId: string) {
  const result = await query<{
    run_id: string; dataset_id: string | null; status: string; snapshot_manifest: unknown; snapshot_sha256: string; snapshot_row_count: number;
    provider: string | null; model: string | null; agent_id: string | null; latency_ms: number | null; error_type: string | null;
    started_at: Date; finished_at: Date | null; candidate_id: string | null; rule_fingerprint: string | null;
    discovery_report: unknown | null; duplicate_of_candidate_id: string | null; proposal_payload: unknown | null; candidate_status: string | null;
    metrics: unknown | null; example_references: unknown | null; evaluator_version: string | null; semantics_note: string | null;
    review_decision: string | null; review_reason: string | null; reviewed_at: Date | null;
    diagnostic_agent_id: string | null; diagnostic_agent_version: string | null; diagnostic_provider: string | null;
    diagnostic_model: string | null; diagnostic_contract_version: string | null; diagnostic_validation_stage: string | null;
    raw_completion: unknown | null; extracted_proposal: unknown | null; validation_issues: unknown | null;
    evidence_reference_failures: unknown | null; supporting_evidence_refs_state: string | null;
    diagnostic_latency_ms: number | null; diagnostic_captured_at: Date | null;
  }>(`
    SELECT run.run_id::text, run.dataset_id::text, run.status, run.snapshot_manifest, run.snapshot_sha256, run.snapshot_row_count,
           run.provider, run.model, run.agent_id, run.latency_ms, run.error_type, run.started_at, run.finished_at,
           run.discovery_report, candidate.candidate_id::text, candidate.rule_fingerprint,
           candidate.duplicate_of_candidate_id::text, candidate.proposal_payload,
           candidate_status.status AS candidate_status, backtest.metrics, backtest.example_references,
           backtest.evaluator_version, backtest.semantics_note,
           review.decision AS review_decision, review.reason AS review_reason, review.reviewed_at,
           diagnostic.agent_id AS diagnostic_agent_id, diagnostic.agent_version AS diagnostic_agent_version,
           diagnostic.provider AS diagnostic_provider, diagnostic.model AS diagnostic_model,
           diagnostic.contract_version AS diagnostic_contract_version,
           diagnostic.validation_stage AS diagnostic_validation_stage,
           diagnostic.raw_completion, diagnostic.extracted_proposal, diagnostic.validation_issues,
           diagnostic.evidence_reference_failures, diagnostic.supporting_evidence_refs_state,
           diagnostic.latency_ms AS diagnostic_latency_ms, diagnostic.captured_at AS diagnostic_captured_at
    FROM fraud_discovery_runs run
    LEFT JOIN fraud_rule_candidates candidate ON candidate.run_id = run.run_id
    LEFT JOIN fraud_rule_candidate_status candidate_status ON candidate_status.candidate_id = candidate.candidate_id
    LEFT JOIN fraud_rule_backtests backtest ON backtest.candidate_id = candidate.candidate_id
    LEFT JOIN fraud_rule_reviews review ON review.candidate_id = candidate.candidate_id
    LEFT JOIN fraud_discovery_diagnostics diagnostic ON diagnostic.run_id = run.run_id
    WHERE run.run_id = $1
  `, [runId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "DISCOVERY_RUN_NOT_FOUND", "That discovery run was not found.");
  return {
    id: row.run_id, datasetId: row.dataset_id, status: row.status, snapshot: row.snapshot_manifest, snapshotSha256: row.snapshot_sha256,
    snapshotRowCount: row.snapshot_row_count, discoveryReport: row.discovery_report,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null, errorType: row.error_type,
    agent: row.provider ? { provider: row.provider, model: row.model, agentId: row.agent_id, latencyMs: row.latency_ms } : null,
    diagnostics: row.diagnostic_validation_stage ? {
      agent: {
        agentId: row.diagnostic_agent_id, agentVersion: row.diagnostic_agent_version,
        provider: row.diagnostic_provider, model: row.diagnostic_model,
        contractVersion: row.diagnostic_contract_version,
      },
      validationStage: row.diagnostic_validation_stage,
      validationIssues: row.validation_issues,
      evidenceReferenceFailures: row.evidence_reference_failures,
      supportingEvidenceRefsState: row.supporting_evidence_refs_state,
      latencyMs: row.diagnostic_latency_ms,
      capturedAt: row.diagnostic_captured_at?.toISOString() ?? null,
      rawCompletion: row.raw_completion,
      extractedProposal: row.extracted_proposal,
    } : null,
    candidate: row.candidate_id ? {
      id: row.candidate_id, fingerprint: row.rule_fingerprint, duplicateOfCandidateId: row.duplicate_of_candidate_id,
      status: row.candidate_status, proposal: row.proposal_payload,
      backtest: row.metrics ? { evaluatorVersion: row.evaluator_version, metrics: row.metrics, examples: row.example_references, semanticsNote: row.semantics_note } : null,
      review: row.review_decision ? { decision: row.review_decision, reason: row.review_reason, reviewedAt: row.reviewed_at?.toISOString() } : null,
    } : null,
  };
}

export async function startDiscoveryAnalysis(analystId: string, idempotencyKey: string) {
  let runId = "";
  const claimed = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fraud-discovery:${analystId}`]);
    const replay = await client.query<{ run_id: string }>(`
      SELECT run_id::text FROM fraud_discovery_runs WHERE analyst_id = $1 AND idempotency_key = $2
    `, [analystId, idempotencyKey]);
    if (replay.rows[0]) return { runId: replay.rows[0].run_id, replay: true, waveIds: [] as string[], snapshotSha256: "" };
    const active = await client.query<{ dataset_id: string }>(`
      SELECT dataset_id::text FROM fraud_lab_active_datasets
      WHERE environment_id = $1 FOR SHARE
    `, [FRAUD_LAB_ENVIRONMENT]);
    if (!active.rows[0]) throw new ApiError(409, "FRAUD_LAB_EMPTY", "No synthetic Fraud Lab dataset is active.");
    const datasetId = active.rows[0].dataset_id;
    const waves = await client.query<WaveRow>(`SELECT wave.* FROM fraud_lab_dataset_waves member
      JOIN fraud_lab_waves wave ON wave.wave_id = member.wave_id
      WHERE member.dataset_id = $1 ORDER BY member.ordinal FOR SHARE OF wave`, [datasetId]);
    if (!waves.rowCount) throw new ApiError(409, "FRAUD_LAB_EMPTY", "No synthetic fraud lab wave is ready.");
    const manifest = {
      datasetId,
      waves: waves.rows.map((wave) => ({ id: wave.wave_id, digest: wave.content_sha256, rowCount: wave.row_count })),
      datasetSchemaVersion: "fraud-lab-dataset/1.0.0",
    };
    const snapshotSha256 = sha256(manifest);
    runId = randomUUID();
    await client.query(`
      INSERT INTO fraud_discovery_runs
        (run_id, analyst_id, idempotency_key, dataset_id, status, snapshot_wave_ids, snapshot_manifest,
         snapshot_sha256, snapshot_row_count)
      VALUES ($1, $2, $3, $4, 'ANALYSING', $5, $6, $7, $8)
    `, [runId, analystId, idempotencyKey, datasetId, JSON.stringify(waves.rows.map((wave) => wave.wave_id)),
      JSON.stringify(manifest), snapshotSha256, waves.rows.reduce((sum, wave) => sum + wave.row_count, 0)]);
    return { runId, replay: false, waveIds: waves.rows.map((wave) => wave.wave_id), snapshotSha256 };
  });
  runId = claimed.runId;
  if (claimed.replay) return getDiscoveryRun(runId);

  try {
    const report = await buildDiscoveryReport(runId, claimed.waveIds, claimed.snapshotSha256);
    const reportSha256 = sha256(report);
    await query(`
      UPDATE fraud_discovery_runs SET discovery_report = $2, discovery_report_sha256 = $3, request_sha256 = $3
      WHERE run_id = $1
    `, [runId, JSON.stringify(report), reportSha256]);
    const discovery = await discoverRule(report);
    try {
      validateEvidenceReferences(discovery.proposal, report);
    } catch (error) {
      if (error instanceof FraudRuleDiscoveryEvidenceReferenceError) {
        throw new FraudRuleDiscoveryDiagnosticError(error.name, error.message, {
          agentId: discovery.agentId,
          agentVersion: "1.0.0",
          provider: discovery.provider,
          model: discovery.model,
          contractVersion: PROPOSAL_SCHEMA_VERSION,
          validationStage: "SEMANTIC",
          rawCompletion: discovery.rawCompletion,
          extractedProposal: discovery.extractedProposal,
          validationIssues: [],
          evidenceReferenceFailures: {
            invalidReferences: error.invalidReferences,
            allowedReferenceCount: error.allowedReferenceCount,
          },
          supportingEvidenceRefsState: "PRESENT",
          latencyMs: discovery.latencyMs,
        });
      }
      throw error;
    }
    const fingerprint = ruleFingerprint(discovery.proposal);
    const candidateId = randomUUID();
    await withTransaction(async (client) => {
      const duplicate = await client.query<{ candidate_id: string }>(`
        SELECT candidate_id::text FROM fraud_rule_candidates WHERE rule_fingerprint = $1
        ORDER BY created_at, candidate_id LIMIT 1 FOR SHARE
      `, [fingerprint]);
      await client.query(`
        INSERT INTO fraud_rule_candidates
          (candidate_id, run_id, rule_identifier, rule_name, rule_fingerprint,
           duplicate_of_candidate_id, proposal_schema_version, proposal_payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [candidateId, runId, discovery.proposal.ruleIdentifier, discovery.proposal.name, fingerprint,
        duplicate.rows[0]?.candidate_id ?? null, PROPOSAL_SCHEMA_VERSION, JSON.stringify(discovery.proposal)]);
      await client.query(`
        UPDATE fraud_discovery_runs SET agent_id = $2, provider = $3, model = $4,
          proposal_schema_version = $5, latency_ms = $6 WHERE run_id = $1
      `, [runId, discovery.agentId, discovery.provider, discovery.model, PROPOSAL_SCHEMA_VERSION, discovery.latencyMs]);
    });

    // Evaluation rows are intentionally loaded only after the validated proposal is durable.
    const evaluation = await query<HistoricalRow>(`
      SELECT transaction_id::text, event_time, customer_id::text, beneficiary_id::text,
             merchant_id::text, amount::text, ground_truth_fraud
      FROM fraud_lab_transactions
      WHERE wave_id = ANY($1::text[]) AND partition = 'EVALUATION'
      ORDER BY event_time, transaction_id
    `, [claimed.waveIds]);
    const result = backtest(evaluation.rows, discovery.proposal);
    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO fraud_rule_backtests
          (backtest_id, candidate_id, snapshot_sha256, evaluator_version, baseline_policy_version,
           evaluated_transaction_count, metrics, example_references, semantics_note)
        VALUES ($1, $2, $3, $4, 'fast-path-policy/1.1.0', $5, $6, $7, $8)
      `, [randomUUID(), candidateId, claimed.snapshotSha256, EVALUATOR_VERSION, evaluation.rowCount,
        JSON.stringify(result.metrics), JSON.stringify(result.examples), SEMANTICS_NOTE]);
      await client.query("UPDATE fraud_discovery_runs SET status = 'COMPLETED', finished_at = now() WHERE run_id = $1", [runId]);
    });
  } catch (error) {
    const diagnostic = error instanceof FraudRuleDiscoveryDiagnosticError
      ? error.diagnostic : fallbackDiscoveryDiagnostic();
    await persistDiscoveryDiagnostic(runId, diagnostic);
    await query(`UPDATE fraud_discovery_runs SET status = 'FAILED', error_type = $2, finished_at = now() WHERE run_id = $1`, [
      runId,
      error instanceof z.ZodError ? "INVALID_AGENT_PROPOSAL" : error instanceof Error ? error.name : "UNKNOWN_ERROR",
    ]);
    throw error;
  }
  return getDiscoveryRun(runId);
}

export const reviewRequestSchema = z.object({
  decision: z.enum(["APPROVED_FOR_IMPLEMENTATION", "REJECTED"]),
  reason: z.string().trim().max(500).optional(),
}).strict();

export async function reviewCandidate(candidateId: string, reviewerId: string, reviewerName: string, input: z.infer<typeof reviewRequestSchema>) {
  let inserted = 0;
  try {
    const result = await query(`
      INSERT INTO fraud_rule_reviews (review_id, candidate_id, decision, reviewer_id, reviewer_name, reason)
      SELECT $1, candidate.candidate_id, $3, $4, $5, $6
      FROM fraud_rule_candidates candidate
      JOIN fraud_rule_backtests backtest ON backtest.candidate_id = candidate.candidate_id
      WHERE candidate.candidate_id = $2
    `, [randomUUID(), candidateId, input.decision, reviewerId, reviewerName, input.reason || null]);
    inserted = result.rowCount ?? 0;
  } catch (error) {
    throw new ApiError(409, "CANDIDATE_ALREADY_REVIEWED", "This candidate already has a final review.");
  }
  const run = await query<{ run_id: string }>("SELECT run_id::text FROM fraud_rule_candidates WHERE candidate_id = $1", [candidateId]);
  if (!run.rows[0]) throw new ApiError(404, "CANDIDATE_NOT_FOUND", "That rule candidate was not found.");
  if (!inserted) {
    throw new ApiError(409, "CANDIDATE_NOT_BACKTESTED", "This candidate must complete backtesting before review.");
  }
  return getDiscoveryRun(run.rows[0].run_id);
}
