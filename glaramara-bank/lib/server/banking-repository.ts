import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { z } from "zod";

import { ApiError, isPostgresError } from "@/lib/server/api-errors";
import { query, withTransaction } from "@/lib/server/db";

type CustomerRow = {
  customer_id: string;
  demo_slug: string;
  first_name: string;
  last_name: string;
  initials: string;
  email: string;
  fictional: boolean;
};

type LocationRow = {
  location_id: string;
  customer_id: string;
  location_key: string;
  label: string;
  is_usual: boolean;
};

type AccountRow = {
  account_id: string;
  account_name: string;
  sort_code: string;
  account_number: string;
  currency: string;
  available_balance: string;
  card_last_four: string;
  balance_as_of: Date;
};

type TransactionRow = {
  transaction_id: string;
  beneficiary_id: string | null;
  direction: "CREDIT" | "DEBIT";
  amount: string;
  currency: string;
  display_name: string;
  category: string;
  booked_at: Date;
  reference: string | null;
};

type SpendingRow = {
  category: string;
  amount: string;
};

type BeneficiaryRow = {
  beneficiary_id: string;
  display_name: string;
  initials: string;
  sort_code: string;
  account_number: string;
  is_seeded: boolean;
  created_at: Date;
  booked_payment_count: string;
  last_paid_at: Date | null;
};

type PaymentContextRow = {
  customer_id: string;
  customer_slug: string;
  account_id: string;
  beneficiary_id: string;
  beneficiary_name: string;
  location_id: string;
  location_key: string;
  location_label: string;
  latitude: string;
  longitude: string;
  device_id: string;
  beneficiary_payment_count: string;
};

type PaymentStatusRow = {
  payment_id: string;
  transaction_id: string;
  beneficiary_id: string;
  beneficiary_name: string;
  amount: string;
  currency: "GBP";
  payment_reference: string;
  event_time: Date;
  submitted_at: Date;
  payment_status: "PENDING" | "APPROVED" | "CHALLENGED" | "BLOCKED";
  decision_id: string | null;
  decision_source: "deterministic_fast_path" | null;
  policy_version: string | null;
  decision_payload: {
    triggered_rule_ids?: string[];
    investigation_required?: boolean;
  } | null;
  decided_at: Date | null;
  publication_status: "PENDING" | "CLAIMED" | "PUBLISHED" | null;
  publication_attempts: number | null;
  publication_last_error_type: string | null;
  published_at: Date | null;
  assessment_revision: string | null;
  assessment: { completeness?: string } | null;
  shadow_policy_version: string | null;
  shadow_processing_status: string | null;
  shadow_status_reason: string | null;
  shadow_decision: {
    shadow_evaluation_id?: string;
    proposed_action?: "APPROVED" | "CHALLENGED" | "BLOCKED";
    original_payment_verdict?: "APPROVED" | "CHALLENGED" | "BLOCKED";
    differs_from_original?: boolean;
    ml?: {
      model_version?: string;
      feature_schema_version?: string;
    };
  } | null;
};

export const sessionRequestSchema = z.object({
  customerId: z.string().uuid(),
  demoLocationId: z.string().uuid().optional(),
});

export const beneficiaryRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  sortCode: z
    .string()
    .trim()
    .regex(/^\d{2}-?\d{2}-?\d{2}$/, "Use a six-digit UK sort code")
    .transform((value) => value.replaceAll("-", "")),
  accountNumber: z.string().trim().regex(/^\d{8}$/, "Use an eight-digit account number"),
});

const paymentAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/, "Use a GBP amount with at most two decimals")
  .transform((value) => {
    const [pounds, pence = ""] = value.split(".");
    return Number(pounds) * 100 + Number(pence.padEnd(2, "0"));
  })
  .refine((minorUnits) => minorUnits >= 1 && minorUnits <= 100_000_000, {
    message: "Enter an amount between £0.01 and £1,000,000.00",
  });

export const paymentRequestSchema = z.object({
  beneficiaryId: z.string().uuid(),
  amount: paymentAmountSchema,
  reference: z.string().trim().min(1).max(24),
});

export type BeneficiaryRequest = z.infer<typeof beneficiaryRequestSchema>;
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;

function customerJson(row: CustomerRow) {
  return {
    id: row.customer_id,
    slug: row.demo_slug,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    initials: row.initials,
    email: row.email,
    fictional: row.fictional,
  };
}

function locationJson(row: LocationRow) {
  return {
    id: row.location_id,
    customerId: row.customer_id,
    key: row.location_key,
    label: row.label,
    isUsual: row.is_usual,
  };
}

function formatSortCode(value: string): string {
  return `${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
}

function transactionIcon(row: TransactionRow): string {
  if (row.direction === "CREDIT") return "↙";
  if (row.category === "TRANSFER") return "↗";
  if (row.category === "HOUSING") return "⌂";
  return row.display_name.trim().charAt(0).toUpperCase() || "•";
}

function displayDate(value: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(value);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(value);
  return `${day} · ${time}`;
}

function transactionJson(row: TransactionRow) {
  const amount = Number(row.amount) * (row.direction === "DEBIT" ? -1 : 1);
  return {
    id: row.transaction_id,
    beneficiaryId: row.beneficiary_id,
    direction: row.direction,
    amount,
    currency: row.currency,
    name: row.display_name,
    displayName: row.display_name,
    category: row.category,
    bookedAt: row.booked_at.toISOString(),
    date: displayDate(row.booked_at),
    icon: transactionIcon(row),
    reference: row.reference,
  };
}

function beneficiaryJson(row: BeneficiaryRow) {
  return {
    id: row.beneficiary_id,
    name: row.display_name,
    displayName: row.display_name,
    initials: row.initials,
    sortCode: formatSortCode(row.sort_code),
    accountNumber: row.account_number,
    isSeeded: row.is_seeded,
    bookedPaymentCount: Number(row.booked_payment_count),
    recent: Number(row.booked_payment_count) > 0,
    lastPaidAt: row.last_paid_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDemoCustomers() {
  const result = await query<CustomerRow>(`
    SELECT customer_id, demo_slug, first_name, last_name, initials, email, fictional
    FROM banking_customers
    WHERE fictional
    ORDER BY CASE WHEN demo_slug = 'alex-morgan' THEN 0 ELSE 1 END, demo_slug
  `);
  return result.rows.map(customerJson);
}

export async function findDefaultDemoCustomer() {
  const result = await query<CustomerRow & LocationRow>(`
    SELECT c.customer_id, c.demo_slug, c.first_name, c.last_name, c.initials, c.email, c.fictional,
           l.location_id, l.location_key, l.label, l.is_usual
    FROM banking_customers c
    JOIN banking_demo_locations l
      ON l.customer_id = c.customer_id AND l.active AND l.is_usual
    WHERE c.demo_slug = 'alex-morgan' AND c.fictional
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new ApiError(503, "DEMO_DATA_UNAVAILABLE", "Fictional demo data is unavailable.");
  return { customer: customerJson(row), location: locationJson(row) };
}

export async function resolveDemoSession(customerId: string, requestedLocationId?: string) {
  const result = await query<CustomerRow & LocationRow>(`
    SELECT c.customer_id, c.demo_slug, c.first_name, c.last_name, c.initials, c.email, c.fictional,
           l.location_id, l.location_key, l.label, l.is_usual
    FROM banking_customers c
    JOIN banking_demo_locations l ON l.customer_id = c.customer_id AND l.active
    WHERE c.customer_id = $1
      AND c.fictional
      AND ($2::uuid IS NULL OR l.location_id = $2::uuid)
    ORDER BY CASE WHEN l.location_id = $2::uuid THEN 0 WHEN l.is_usual THEN 1 ELSE 2 END,
             l.location_key
    LIMIT 1
  `, [customerId, requestedLocationId ?? null]);
  const row = result.rows[0];
  if (!row) {
    throw new ApiError(
      404,
      "DEMO_CUSTOMER_NOT_FOUND",
      "The fictional customer or selected demo location was not found.",
    );
  }
  return { customer: customerJson(row), location: locationJson(row) };
}

export async function listDemoLocations(customerId: string) {
  const result = await query<LocationRow>(`
    SELECT location_id, customer_id, location_key, label, is_usual
    FROM banking_demo_locations
    WHERE customer_id = $1 AND active
    ORDER BY is_usual DESC, location_key
  `, [customerId]);
  return result.rows.map(locationJson);
}

export async function getDashboard(customerId: string) {
  const customerAccount = await query<CustomerRow & AccountRow>(`
    SELECT c.customer_id, c.demo_slug, c.first_name, c.last_name, c.initials, c.email, c.fictional,
           a.account_id, a.account_name, a.sort_code, a.account_number, a.currency,
           a.available_balance, a.card_last_four, a.balance_as_of
    FROM banking_customers c
    JOIN banking_accounts a ON a.customer_id = c.customer_id AND a.is_primary AND a.status = 'OPEN'
    WHERE c.customer_id = $1 AND c.fictional
    LIMIT 1
  `, [customerId]);
  const row = customerAccount.rows[0];
  if (!row) throw new ApiError(404, "DEMO_CUSTOMER_NOT_FOUND", "Fictional customer not found.");

  const [transactions, spending] = await Promise.all([
    query<TransactionRow>(`
      SELECT transaction_id, beneficiary_id, direction, amount, currency, display_name,
             category, booked_at, reference
      FROM banking_transactions
      WHERE customer_id = $1
      ORDER BY booked_at DESC, transaction_id
      LIMIT 8
    `, [customerId]),
    query<SpendingRow>(`
      SELECT
        CASE
          WHEN category IN ('HOUSING', 'BILLS') THEN 'HOME_AND_BILLS'
          WHEN category IN ('FOOD_AND_DRINK', 'EVERYDAY') THEN 'FOOD_AND_DRINK'
          WHEN category = 'TRAVEL' THEN 'TRAVEL'
          WHEN category = 'TRANSFER' THEN 'TRANSFERS'
          ELSE 'OTHER'
        END AS category,
        SUM(amount)::text AS amount
      FROM banking_transactions
      WHERE customer_id = $1
        AND direction = 'DEBIT'
        AND booked_at >= date_trunc('month', $2::timestamptz)
        AND booked_at < date_trunc('month', $2::timestamptz) + interval '1 month'
      GROUP BY 1
      ORDER BY SUM(amount) DESC, 1
    `, [customerId, row.balance_as_of]),
  ]);

  return {
    customer: customerJson(row),
    account: {
      id: row.account_id,
      name: row.account_name,
      sortCode: formatSortCode(row.sort_code),
      accountNumber: row.account_number,
      accountSuffix: row.account_number.slice(-4),
      currency: row.currency,
      availableBalance: Number(row.available_balance),
      cardLastFour: row.card_last_four,
      balanceAsOf: row.balance_as_of.toISOString(),
      ledgerMode: "SIMULATED_NO_MOVEMENT" as const,
    },
    recentTransactions: transactions.rows.map(transactionJson),
    spending: spending.rows.map((item) => ({
      category: item.category,
      label: {
        HOME_AND_BILLS: "Home & bills",
        FOOD_AND_DRINK: "Food & drink",
        TRAVEL: "Travel",
        TRANSFERS: "Transfers",
        OTHER: "Other",
      }[item.category] ?? "Other",
      amount: Number(item.amount),
    })),
  };
}

export async function getActivity(customerId: string) {
  const result = await query<TransactionRow>(`
    SELECT transaction_id, beneficiary_id, direction, amount, currency, display_name,
           category, booked_at, reference
    FROM banking_transactions
    WHERE customer_id = $1
    ORDER BY booked_at DESC, transaction_id
  `, [customerId]);
  return result.rows.map(transactionJson);
}

export async function listBeneficiaries(customerId: string) {
  const result = await query<BeneficiaryRow>(`
    SELECT b.beneficiary_id, b.display_name, b.initials, b.sort_code, b.account_number,
           b.is_seeded, b.created_at, COUNT(t.transaction_id)::text AS booked_payment_count,
           MAX(t.booked_at) AS last_paid_at
    FROM banking_beneficiaries b
    LEFT JOIN banking_transactions t
      ON t.customer_id = b.customer_id AND t.beneficiary_id = b.beneficiary_id
    WHERE b.customer_id = $1
    GROUP BY b.beneficiary_id
    ORDER BY MAX(t.booked_at) DESC NULLS LAST, b.display_name
  `, [customerId]);
  return result.rows.map(beneficiaryJson);
}

function initialsFor(displayName: string): string {
  const parts = displayName
    .split(/\s+/)
    .map((part) => part.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return "B";
  const selected = parts.length === 1 ? parts : [parts[0], parts.at(-1)!];
  return selected.map((part) => part[0].toUpperCase()).join("").slice(0, 3);
}

export async function createBeneficiary(customerId: string, input: BeneficiaryRequest) {
  try {
    const result = await query<BeneficiaryRow>(`
      WITH inserted AS (
        INSERT INTO banking_beneficiaries
          (beneficiary_id, customer_id, display_name, initials, sort_code, account_number, is_seeded)
        SELECT $1, c.customer_id, $3, $4, $5, $6, false
        FROM banking_customers c
        WHERE c.customer_id = $2 AND c.fictional
        RETURNING beneficiary_id, display_name, initials, sort_code, account_number,
                  is_seeded, created_at
      )
      SELECT inserted.*, '0'::text AS booked_payment_count, NULL::timestamptz AS last_paid_at
      FROM inserted
    `, [
      randomUUID(),
      customerId,
      input.displayName,
      initialsFor(input.displayName),
      input.sortCode,
      input.accountNumber,
    ]);
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "DEMO_CUSTOMER_NOT_FOUND", "Fictional customer not found.");
    return beneficiaryJson(row);
  } catch (error) {
    if (isPostgresError(error, "23505")) {
      throw new ApiError(
        409,
        "BENEFICIARY_EXISTS",
        "That beneficiary account already exists for this customer.",
      );
    }
    throw error;
  }
}

function canonicalPaymentRequest(input: PaymentRequest): string {
  return JSON.stringify({
    amountMinor: input.amount,
    beneficiaryId: input.beneficiaryId,
    currency: "GBP",
    reference: input.reference,
  });
}

function requestDigest(input: PaymentRequest): string {
  return createHash("sha256").update(canonicalPaymentRequest(input)).digest("hex");
}

function flinkEventTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

async function reserveRawEventTimes(client: PoolClient): Promise<{
  eventTime: Date;
  watermarkTime: Date;
}> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('payments.raw.demo:event-time', 0))",
  );
  const clock = await client.query<{ last_event_time: Date }>(`
    SELECT last_event_time
    FROM raw_event_time_clock
    WHERE stream_name = 'payments.raw.demo'
  `);
  const previousTime = clock.rows[0]?.last_event_time.getTime() ?? 0;
  const eventTime = new Date(Math.max(Date.now(), previousTime + 5));
  const watermarkTime = new Date(eventTime.getTime() + 3_000);
  await client.query(`
    INSERT INTO raw_event_time_clock (stream_name, last_event_time)
    VALUES ('payments.raw.demo', $1)
    ON CONFLICT (stream_name) DO UPDATE
    SET last_event_time = EXCLUDED.last_event_time, updated_at = now()
  `, [watermarkTime]);
  return { eventTime, watermarkTime };
}

async function findPaymentContext(
  client: PoolClient,
  customerId: string,
  beneficiaryId: string,
  locationId: string,
): Promise<PaymentContextRow> {
  const result = await client.query<PaymentContextRow>(`
    SELECT c.customer_id, c.demo_slug AS customer_slug, a.account_id,
           b.beneficiary_id, b.display_name AS beneficiary_name,
           l.location_id, l.location_key, l.label AS location_label,
           l.latitude::text, l.longitude::text, l.device_id,
           (SELECT count(*)::text
            FROM banking_transactions booked
            WHERE booked.customer_id = c.customer_id
              AND booked.beneficiary_id = b.beneficiary_id) AS beneficiary_payment_count
    FROM banking_customers c
    JOIN banking_accounts a
      ON a.customer_id = c.customer_id AND a.is_primary AND a.status = 'OPEN'
    JOIN banking_beneficiaries b
      ON b.customer_id = c.customer_id AND b.beneficiary_id = $2
    JOIN banking_demo_locations l
      ON l.customer_id = c.customer_id AND l.location_id = $3 AND l.active
    WHERE c.customer_id = $1 AND c.fictional
    LIMIT 1
    FOR SHARE OF c, a, b, l
  `, [customerId, beneficiaryId, locationId]);
  const context = result.rows[0];
  if (!context) {
    throw new ApiError(
      404,
      "PAYMENT_CONTEXT_NOT_FOUND",
      "The fictional account, beneficiary or demo location is not available for this customer.",
    );
  }
  return context;
}

export async function createPaymentAttempt(
  customerId: string,
  locationId: string,
  idempotencyKey: string,
  input: PaymentRequest,
) {
  const digest = requestDigest(input);
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `glaramara-payment:${customerId}:${idempotencyKey}`,
    ]);
    const existing = await client.query<{ payment_id: string; request_sha256: string }>(`
      SELECT payment_id, request_sha256
      FROM banking_payment_attempts
      WHERE customer_id = $1 AND idempotency_key = $2
      FOR SHARE
    `, [customerId, idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_sha256 !== digest) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for different payment details.",
        );
      }
      return { paymentId: existing.rows[0].payment_id, replayed: true };
    }

    const context = await findPaymentContext(client, customerId, input.beneficiaryId, locationId);
    const paymentId = randomUUID();
    const transactionId = paymentId;
    const rawEventId = randomUUID();
    const watermarkEventId = randomUUID();
    const { eventTime, watermarkTime } = await reserveRawEventTimes(client);
    const amount = input.amount / 100;
    const rawEvent = {
      transaction_id: transactionId,
      user_id: context.customer_id,
      merchant_id: `beneficiary:${context.beneficiary_id}`,
      amount,
      device_id: context.device_id,
      payment_channel: "OTHER",
      beneficiary_payment_count: Number(context.beneficiary_payment_count),
      event_time: flinkEventTime(eventTime),
    };
    const trustedContext = {
      schemaVersion: "1.0.0",
      source: "glaramara-bank",
      customerId: context.customer_id,
      customerSlug: context.customer_slug,
      accountId: context.account_id,
      beneficiaryId: context.beneficiary_id,
      beneficiaryName: context.beneficiary_name,
      demoLocation: {
        id: context.location_id,
        key: context.location_key,
        label: context.location_label,
        latitude: Number(context.latitude),
        longitude: Number(context.longitude),
        deviceId: context.device_id,
      },
      paymentChannel: "OTHER",
      ledgerEffect: "NONE",
      simulated: true,
    };

    await client.query(`
      INSERT INTO banking_payment_attempts
        (payment_id, transaction_id, customer_id, account_id, beneficiary_id,
         demo_location_id, amount, currency, payment_reference, idempotency_key,
         request_sha256, raw_event_payload, trusted_context_snapshot, event_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'GBP', $8, $9, $10, $11, $12, $13)
    `, [
      paymentId,
      transactionId,
      context.customer_id,
      context.account_id,
      context.beneficiary_id,
      context.location_id,
      amount.toFixed(2),
      input.reference,
      idempotencyKey,
      digest,
      rawEvent,
      trustedContext,
      eventTime,
    ]);
    await client.query(`
      INSERT INTO outbox_events
        (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
         schema_version, payload)
      VALUES ($1, 'banking_payment_raw', $2, 'payments.raw.demo', $3, '1.0.0', $4)
    `, [rawEventId, paymentId, transactionId, rawEvent]);
    await client.query(`
      INSERT INTO outbox_events
        (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
         schema_version, payload, available_at)
      VALUES ($1, 'banking_payment_watermark', $2, 'payments.raw.demo', '__watermark__',
              '1.0.0', $3, clock_timestamp() + interval '3 seconds')
    `, [
      watermarkEventId,
      paymentId,
      {
        transaction_id: `${transactionId}-watermark`,
        user_id: "__watermark__",
        merchant_id: "__none__",
        amount: 0,
        device_id: "__none__",
        payment_channel: "OTHER",
        event_time: flinkEventTime(watermarkTime),
      },
    ]);
    return { paymentId, replayed: false };
  });

  console.info(JSON.stringify({
    event: result.replayed ? "banking_payment_replayed" : "banking_payment_accepted",
    payment_id: result.paymentId,
    customer_id: customerId,
  }));
  return { payment: await getPaymentStatus(customerId, result.paymentId), replayed: result.replayed };
}

export async function getPaymentStatus(customerId: string, paymentId: string) {
  const result = await query<PaymentStatusRow>(`
    SELECT status.payment_id, status.transaction_id, status.beneficiary_id,
           beneficiary.display_name AS beneficiary_name,
           status.amount, status.currency, status.payment_reference,
           status.event_time, status.submitted_at, status.payment_status,
           status.decision_id, status.decision_source, status.policy_version,
           status.decision_payload, status.decided_at,
           status.publication_status, status.publication_attempts,
           status.publication_last_error_type, status.published_at,
           assessment.revision::text AS assessment_revision,
           assessment.assessment,
           shadow_state.policy_version AS shadow_policy_version,
           shadow_event.processing_status AS shadow_processing_status,
           shadow_event.status_reason AS shadow_status_reason,
           shadow_history.decision AS shadow_decision
    FROM banking_payment_status status
    JOIN banking_beneficiaries beneficiary
      ON beneficiary.beneficiary_id = status.beneficiary_id
     AND beneficiary.customer_id = status.customer_id
    LEFT JOIN fraud_assessments_latest assessment
      ON assessment.transaction_id = status.transaction_id
    LEFT JOIN fraud_shadow_decision_state shadow_state
      ON shadow_state.transaction_id = status.transaction_id
     AND shadow_state.policy_version = 'fraud-action-policy-v1'
    LEFT JOIN fraud_shadow_assessment_events shadow_event
      ON shadow_event.source_assessment_id = shadow_state.source_assessment_id
     AND shadow_event.source_revision = shadow_state.latest_source_revision
     AND shadow_event.policy_version = shadow_state.policy_version
    LEFT JOIN fraud_shadow_decision_history shadow_history
      ON shadow_history.source_assessment_id = shadow_state.source_assessment_id
     AND shadow_history.source_revision = shadow_state.latest_source_revision
     AND shadow_history.policy_version = shadow_state.policy_version
    WHERE status.customer_id = $1 AND status.payment_id = $2
    LIMIT 1
  `, [customerId, paymentId]);
  const row = result.rows[0];
  if (!row) {
    throw new ApiError(404, "PAYMENT_NOT_FOUND", "Fictional payment attempt not found.");
  }

  const ageMs = Math.max(0, Date.now() - row.submitted_at.getTime());
  return {
    id: row.payment_id,
    transactionId: row.transaction_id,
    beneficiary: { id: row.beneficiary_id, name: row.beneficiary_name },
    amount: Number(row.amount),
    currency: row.currency,
    reference: row.payment_reference,
    status: row.payment_status,
    submittedAt: row.submitted_at.toISOString(),
    eventTime: row.event_time.toISOString(),
    simulated: true,
    ledgerEffect: "NONE" as const,
    processing: {
      publicationStatus: row.publication_status ?? "PENDING",
      attempts: row.publication_attempts ?? 0,
      lastErrorType: row.publication_last_error_type,
      publishedAt: row.published_at?.toISOString() ?? null,
      delayed: row.payment_status === "PENDING" && ageMs >= 30_000,
    },
    authoritativeDecision: row.decision_id
      ? {
          id: row.decision_id,
          source: row.decision_source,
          policyVersion: row.policy_version,
          triggeredRuleIds: row.decision_payload?.triggered_rule_ids ?? [],
          investigationRequired: row.decision_payload?.investigation_required ?? false,
          decidedAt: row.decided_at?.toISOString() ?? null,
        }
      : null,
    correlation: row.assessment
      ? {
          revision: Number(row.assessment_revision),
          completeness: row.assessment.completeness ?? "PARTIAL",
        }
      : null,
    experimentalShadow: row.shadow_policy_version
      ? {
          policyVersion: row.shadow_policy_version,
          status: row.shadow_processing_status ?? "AWAITING_INPUTS",
          statusReason: row.shadow_status_reason,
          evaluationId: row.shadow_decision?.shadow_evaluation_id ?? null,
          proposedAction: row.shadow_decision?.proposed_action ?? null,
          originalPaymentVerdict: row.shadow_decision?.original_payment_verdict ?? null,
          differsFromOriginal: row.shadow_decision?.differs_from_original ?? null,
          modelVersion: row.shadow_decision?.ml?.model_version ?? null,
          featureSchemaVersion: row.shadow_decision?.ml?.feature_schema_version ?? null,
        }
      : null,
  };
}
