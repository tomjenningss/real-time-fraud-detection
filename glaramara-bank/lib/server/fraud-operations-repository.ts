import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  featureCatalogue,
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
import { discoverRule } from "@/lib/fraud-rule-discovery/orchestrate-client";
import { ApiError } from "@/lib/server/api-errors";
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
  const [waves, totals, runs] = await Promise.all([
    query<WaveRow>(`SELECT wave.* FROM fraud_lab_waves wave WHERE wave.status = 'READY'
      AND NOT EXISTS (SELECT 1 FROM fraud_lab_wave_supersessions supersession
                      WHERE supersession.superseded_wave_id = wave.wave_id)
      ORDER BY wave.period_start`),
    query<{ total: string; fraud: string; detected: string }>(`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE ground_truth_fraud)::text AS fraud,
             count(*) FILTER (WHERE ground_truth_fraud AND baseline_action <> 'APPROVED')::text AS detected
      FROM fraud_lab_transactions transaction_row
      WHERE NOT EXISTS (
        SELECT 1 FROM fraud_lab_wave_supersessions supersession
        WHERE supersession.superseded_wave_id = transaction_row.wave_id
      )
    `),
    query<{ run_id: string; status: string; snapshot_row_count: number; started_at: Date; finished_at: Date | null; candidate_id: string | null; rule_name: string | null; candidate_status: string | null }>(`
      SELECT run.run_id::text, run.status, run.snapshot_row_count, run.started_at, run.finished_at,
             candidate.candidate_id::text, candidate.rule_name, candidate_status.status AS candidate_status
      FROM fraud_discovery_runs run
      LEFT JOIN fraud_rule_candidates candidate ON candidate.run_id = run.run_id
      LEFT JOIN fraud_rule_candidate_status candidate_status ON candidate_status.candidate_id = candidate.candidate_id
      ORDER BY run.started_at DESC LIMIT 20
    `),
  ]);
  const total = Number(totals.rows[0]?.total ?? 0);
  const fraud = Number(totals.rows[0]?.fraud ?? 0);
  const detected = Number(totals.rows[0]?.detected ?? 0);
  return {
    synthetic: true,
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
    run_id: string; status: string; snapshot_manifest: unknown; snapshot_sha256: string; snapshot_row_count: number;
    provider: string | null; model: string | null; agent_id: string | null; latency_ms: number | null; error_type: string | null;
    started_at: Date; finished_at: Date | null; candidate_id: string | null; rule_fingerprint: string | null;
    duplicate_of_candidate_id: string | null; proposal_payload: unknown | null; candidate_status: string | null;
    metrics: unknown | null; example_references: unknown | null; evaluator_version: string | null; semantics_note: string | null;
    review_decision: string | null; review_reason: string | null; reviewed_at: Date | null;
  }>(`
    SELECT run.run_id::text, run.status, run.snapshot_manifest, run.snapshot_sha256, run.snapshot_row_count,
           run.provider, run.model, run.agent_id, run.latency_ms, run.error_type, run.started_at, run.finished_at,
           candidate.candidate_id::text, candidate.rule_fingerprint,
           candidate.duplicate_of_candidate_id::text, candidate.proposal_payload,
           candidate_status.status AS candidate_status, backtest.metrics, backtest.example_references,
           backtest.evaluator_version, backtest.semantics_note,
           review.decision AS review_decision, review.reason AS review_reason, review.reviewed_at
    FROM fraud_discovery_runs run
    LEFT JOIN fraud_rule_candidates candidate ON candidate.run_id = run.run_id
    LEFT JOIN fraud_rule_candidate_status candidate_status ON candidate_status.candidate_id = candidate.candidate_id
    LEFT JOIN fraud_rule_backtests backtest ON backtest.candidate_id = candidate.candidate_id
    LEFT JOIN fraud_rule_reviews review ON review.candidate_id = candidate.candidate_id
    WHERE run.run_id = $1
  `, [runId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "DISCOVERY_RUN_NOT_FOUND", "That discovery run was not found.");
  return {
    id: row.run_id, status: row.status, snapshot: row.snapshot_manifest, snapshotSha256: row.snapshot_sha256,
    snapshotRowCount: row.snapshot_row_count, startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null, errorType: row.error_type,
    agent: row.provider ? { provider: row.provider, model: row.model, agentId: row.agent_id, latencyMs: row.latency_ms } : null,
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
    const waves = await client.query<WaveRow>(`SELECT wave.* FROM fraud_lab_waves wave
      WHERE wave.status = 'READY' AND NOT EXISTS (
        SELECT 1 FROM fraud_lab_wave_supersessions supersession
        WHERE supersession.superseded_wave_id = wave.wave_id
      ) ORDER BY wave.period_start FOR SHARE OF wave`);
    if (!waves.rowCount) throw new ApiError(409, "FRAUD_LAB_EMPTY", "No synthetic fraud lab wave is ready.");
    const manifest = {
      waves: waves.rows.map((wave) => ({ id: wave.wave_id, digest: wave.content_sha256, rowCount: wave.row_count })),
      datasetSchemaVersion: "fraud-lab-dataset/1.0.0",
    };
    const snapshotSha256 = sha256(manifest);
    runId = randomUUID();
    await client.query(`
      INSERT INTO fraud_discovery_runs
        (run_id, analyst_id, idempotency_key, status, snapshot_wave_ids, snapshot_manifest,
         snapshot_sha256, snapshot_row_count)
      VALUES ($1, $2, $3, 'ANALYSING', $4, $5, $6, $7)
    `, [runId, analystId, idempotencyKey, JSON.stringify(waves.rows.map((wave) => wave.wave_id)),
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
    validateEvidenceReferences(discovery.proposal, report);
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
