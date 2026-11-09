import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { ApiError } from "@/lib/server/api-errors";
import { query, withTransaction } from "@/lib/server/db";

const RAW_TOPIC = "payments.raw.slow-building-replay";
const ENRICHED_TOPIC = "payments.enriched.slow-building-replay";
const AMOUNTS = [200, 400, 750, 1_500, 3_000] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

type ContextRow = {
  customer_id: string;
  customer_name: string;
  account_id: string;
  beneficiary_id: string;
  beneficiary_name: string;
  location_id: string;
  device_id: string;
};

type RunRow = {
  run_id: string;
  customer_id: string;
  customer_name: string;
  beneficiary_id: string;
  beneficiary_name: string;
  payment_id: string;
  transaction_ids: string[];
  scenario_payload: { amounts: number[]; eventTimes: string[] };
  event_time_start: Date;
  event_time_end: Date;
  raw_topic: string;
  enriched_topic: string;
  baseline_policy_version: string;
  demo_policy_version: string;
  created_at: Date;
};

type DecisionRow = {
  transaction_id: string;
  payment_verdict: "APPROVED" | "CHALLENGED" | "BLOCKED" | null;
  policy_version: string | null;
  decision_payload: {
    triggered_rule_ids?: string[];
    baseline_policy_version?: string;
    baseline_payment_verdict?: "APPROVED" | "CHALLENGED" | "BLOCKED";
  } | null;
  enrichment_evidence: {
    signals?: string[];
    slow_building_beneficiary_evidence?: {
      payments_30d: number;
      cumulative_amount_30d: number;
      successive_growth_count: number;
      successive_pair_count: number;
      current_to_first_amount_ratio: number;
      observed_relationship_age_days: number;
    };
  } | null;
};

function flinkEventTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function createSlowBuildingDemoRun() {
  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('slow-building-demo:event-time', 0))",
    );
    const context = await client.query<ContextRow>(`
      SELECT customer.customer_id,
             customer.first_name || ' ' || customer.last_name AS customer_name,
             account.account_id, beneficiary.beneficiary_id,
             beneficiary.display_name AS beneficiary_name,
             location.location_id, location.device_id
      FROM banking_customers customer
      JOIN banking_accounts account
        ON account.customer_id = customer.customer_id AND account.is_primary
      JOIN LATERAL (
        SELECT candidate.* FROM banking_beneficiaries candidate
        WHERE candidate.customer_id = customer.customer_id
        ORDER BY candidate.is_seeded DESC, candidate.created_at, candidate.beneficiary_id
        LIMIT 1
      ) beneficiary ON true
      JOIN banking_demo_locations location
        ON location.customer_id = customer.customer_id AND location.is_usual AND location.active
      WHERE customer.demo_slug = 'alex-morgan' AND customer.fictional
      LIMIT 1
      FOR SHARE OF customer, account, location
    `);
    const selected = context.rows[0];
    if (!selected) {
      throw new ApiError(409, "SLOW_BUILDING_DEMO_CONTEXT_MISSING", "The demo customer context is unavailable.");
    }
    const prior = await client.query<{ event_time_end: Date }>(`
      SELECT event_time_end FROM slow_building_demo_runs
      ORDER BY event_time_end DESC LIMIT 1
      FOR SHARE
    `);
    const earliestNaturalStart = Date.now() - 4 * WEEK_MS;
    const afterPriorWatermark = prior.rows[0] ? prior.rows[0].event_time_end.getTime() + 3_005 : 0;
    const start = new Date(Math.max(earliestNaturalStart, afterPriorWatermark));
    const eventTimes = AMOUNTS.map((_, index) => new Date(start.getTime() + index * WEEK_MS));
    const runId = randomUUID();
    const transactionIds = AMOUNTS.map(() => randomUUID());
    const paymentId = transactionIds[4];
    const merchantId = `beneficiary:${selected.beneficiary_id}`;
    const rawEvents = AMOUNTS.map((amount, index) => ({
      transaction_id: transactionIds[index],
      user_id: `slow-building-replay:${runId}:${selected.customer_id}`,
      merchant_id: merchantId,
      amount,
      device_id: selected.device_id,
      payment_channel: "OTHER",
      beneficiary_payment_count: index,
      beneficiary_id: selected.beneficiary_id,
      event_time: flinkEventTime(eventTimes[index]),
    }));
    const finalEvent = rawEvents[4];
    const trustedContext = {
      schemaVersion: "1.0.0",
      source: "glaramara-slow-building-replay",
      customerId: selected.customer_id,
      accountId: selected.account_id,
      beneficiaryId: selected.beneficiary_id,
      beneficiaryName: selected.beneficiary_name,
      replayRunId: runId,
      replayTopics: { raw: RAW_TOPIC, enriched: ENRICHED_TOPIC },
      ledgerEffect: "NONE",
      simulated: true,
    };
    await client.query(`
      INSERT INTO banking_payment_attempts
        (payment_id, transaction_id, customer_id, account_id, beneficiary_id,
         demo_location_id, amount, currency, payment_reference, idempotency_key,
         request_sha256, raw_event_payload, trusted_context_snapshot, event_time)
      VALUES ($1, $2, $3, $4, $5, $6, '3000.00', 'GBP', 'Investment demo', $7, $8, $9, $10, $11)
    `, [
      paymentId,
      paymentId,
      selected.customer_id,
      selected.account_id,
      selected.beneficiary_id,
      selected.location_id,
      `slow-building-replay:${runId}`,
      requestHash({ runId, amount: 3_000, beneficiaryId: selected.beneficiary_id }),
      finalEvent,
      trustedContext,
      eventTimes[4],
    ]);
    await client.query(`
      INSERT INTO slow_building_demo_runs
        (run_id, customer_id, beneficiary_id, payment_id, transaction_ids,
         scenario_payload, event_time_start, event_time_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      runId,
      selected.customer_id,
      selected.beneficiary_id,
      paymentId,
      JSON.stringify(transactionIds),
      { amounts: [...AMOUNTS], eventTimes: eventTimes.map((value) => value.toISOString()) },
      eventTimes[0],
      eventTimes[4],
    ]);
    for (let index = 0; index < rawEvents.length; index += 1) {
      await client.query(`
        INSERT INTO outbox_events
          (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
           schema_version, payload)
        VALUES ($1, $2, $3, $4, $5, '1.0.0', $6)
      `, [
        randomUUID(),
        index === 4 ? "banking_payment_raw" : "slow_building_demo_raw",
        transactionIds[index],
        RAW_TOPIC,
        transactionIds[index],
        rawEvents[index],
      ]);
    }
    const watermark = new Date(eventTimes[4].getTime() + 3_000);
    await client.query(`
      INSERT INTO outbox_events
        (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
         schema_version, payload, available_at)
      VALUES ($1, 'slow_building_demo_watermark', $2, $3, '__watermark__', '1.0.0', $4,
              clock_timestamp() + interval '3 seconds')
    `, [randomUUID(), runId, RAW_TOPIC, {
      transaction_id: `${runId}-watermark`, user_id: "__watermark__", merchant_id: "__none__",
      amount: 0, device_id: "__none__", payment_channel: "OTHER", event_time: flinkEventTime(watermark),
    }]);
    return { runId, paymentId };
  });
}

export async function getSlowBuildingDemoRun(runId: string) {
  const result = await query<RunRow>(`
    SELECT run.run_id, run.customer_id,
           customer.first_name || ' ' || customer.last_name AS customer_name,
           run.beneficiary_id, beneficiary.display_name AS beneficiary_name,
           run.payment_id, run.transaction_ids, run.scenario_payload,
           run.event_time_start, run.event_time_end, run.raw_topic, run.enriched_topic,
           run.baseline_policy_version, run.demo_policy_version, run.created_at
    FROM slow_building_demo_runs run
    JOIN banking_customers customer ON customer.customer_id = run.customer_id
    JOIN banking_beneficiaries beneficiary ON beneficiary.beneficiary_id = run.beneficiary_id
    WHERE run.run_id = $1
  `, [runId]);
  const run = result.rows[0];
  if (!run) throw new ApiError(404, "SLOW_BUILDING_DEMO_NOT_FOUND", "That replay run was not found.");
  const decisions = await query<DecisionRow>(`
    SELECT ids.transaction_id, decision.payment_verdict, decision.policy_version,
           decision.decision_payload, decision.enrichment_evidence
    FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY ids(transaction_id, position)
    LEFT JOIN payment_decisions decision ON decision.transaction_id = ids.transaction_id
    ORDER BY ids.position
  `, [JSON.stringify(run.transaction_ids)]);
  const payments = decisions.rows.map((decision, index) => {
    const signals = decision.enrichment_evidence?.signals ?? [];
    return {
      week: index + 1,
      transactionId: decision.transaction_id,
      eventTime: run.scenario_payload.eventTimes[index],
      amount: run.scenario_payload.amounts[index],
      processingStatus: decision.payment_verdict ? "COMPLETE" : "PENDING",
      signals,
      features: decision.enrichment_evidence?.slow_building_beneficiary_evidence ?? null,
      baseline: {
        policyVersion: decision.decision_payload?.baseline_policy_version
          ?? run.baseline_policy_version,
        verdict: decision.decision_payload?.baseline_payment_verdict ?? null,
      },
      demo: {
        policyVersion: decision.policy_version ?? run.demo_policy_version,
        verdict: decision.payment_verdict,
        triggeredRuleIds: decision.decision_payload?.triggered_rule_ids ?? [],
      },
    };
  });
  return {
    runId: run.run_id,
    paymentId: run.payment_id,
    customer: { id: run.customer_id, name: run.customer_name },
    beneficiary: { id: run.beneficiary_id, name: run.beneficiary_name },
    topics: { raw: run.raw_topic, enriched: run.enriched_topic },
    eventTimeStart: run.event_time_start.toISOString(),
    eventTimeEnd: run.event_time_end.toISOString(),
    createdAt: run.created_at.toISOString(),
    complete: payments.every((payment) => payment.processingStatus === "COMPLETE"),
    payments,
    isolation: {
      liveTopicsUntouched: true,
      ledgerEffect: "NONE",
      replayKey: `slow-building-replay:${run.run_id}`,
    },
  };
}
