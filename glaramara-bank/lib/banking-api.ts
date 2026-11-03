import type { Beneficiary, DemoCustomer, Transaction } from "@/lib/demo-data";

export type DemoLocation = {
  id: string;
  key: string;
  label: string;
  isUsual: boolean;
};

export type DemoSessionResponse = {
  session: {
    customerId: string;
    demoLocationId: string | null;
    role?: "CUSTOMER" | "FRAUD_ANALYST";
    expiresAt: string;
  };
  customers: DemoCustomer[];
  locations: DemoLocation[];
};

export type BankingAccount = {
  id: string;
  name: string;
  sortCode: string;
  accountNumber: string;
  accountSuffix: string;
  currency: "GBP";
  availableBalance: number;
  cardLastFour: string;
  balanceAsOf: string;
};

export type SpendingCategory = {
  category: string;
  label: string;
  amount: number;
};

export type DashboardResponse = {
  customer: DemoCustomer;
  account: BankingAccount;
  recentTransactions: Transaction[];
  spending: SpendingCategory[];
};

export type ActivityResponse = { transactions: Transaction[] };
export type BeneficiariesResponse = { beneficiaries: Beneficiary[] };

export type PaymentStatus = "PENDING" | "APPROVED" | "CHALLENGED" | "BLOCKED";

export type Payment = {
  id: string;
  transactionId: string;
  beneficiary: { id: string; name: string };
  amount: number;
  currency: "GBP";
  reference: string;
  status: PaymentStatus;
  submittedAt: string;
  eventTime: string;
  simulated: true;
  ledgerEffect: "NONE";
  processing: {
    publicationStatus: "PENDING" | "CLAIMED" | "PUBLISHED";
    attempts: number;
    lastErrorType: string | null;
    publishedAt: string | null;
    delayed: boolean;
  };
  authoritativeDecision: {
    id: string;
    source: "deterministic_fast_path";
    policyVersion: string;
    triggeredRuleIds: string[];
    investigationRequired: boolean;
    decidedAt: string | null;
  } | null;
  correlation: {
    revision: number;
    completeness: string;
  } | null;
  experimentalShadow: {
    policyVersion: string;
    status: string;
    statusReason: string | null;
    evaluationId: string | null;
    proposedAction: "APPROVED" | "CHALLENGED" | "BLOCKED" | null;
    originalPaymentVerdict: "APPROVED" | "CHALLENGED" | "BLOCKED" | null;
    differsFromOriginal: boolean | null;
    modelVersion: string | null;
    featureSchemaVersion: string | null;
  } | null;
};

export type PaymentSubmissionResponse = { payment: Payment; replayed: boolean };
export type PaymentStatusResponse = { payment: Payment };

export type InvestigationQuestion = {
  id: string;
  version: string;
  prompt: string;
  helpText?: string;
  kind: "SINGLE_CHOICE" | "SHORT_TEXT";
  options?: Array<{ value: string; label: string }>;
  required: true;
};

export type FraudInvestigation = {
  id: string;
  paymentId: string;
  status: "IN_PROGRESS" | "READY_FOR_EXTRACTION" | "EXTRACTING" | "NEEDS_CLARIFICATION" | "REASSESSED" | "FAILED";
  questionnaireVersion: string;
  questions: InvestigationQuestion[];
  answers: Record<string, { value: string; answeredAt: string; source: "DEFINITION" | "AI_VALIDATED" }>;
  currentQuestionId: string | null;
  answeredCount: number;
  selectedQuestionCount: number;
  agentInvocationCount: number;
  canExtract: boolean;
  reassessmentLifecycle: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  lifecycleUpdatedAt: string;
  resolution: {
    outcome: "CLEARED" | "REQUIRES_FURTHER_REVIEW" | "DECLINED";
    policyVersion: string;
    reasonCodes: string[];
    reassessedAt: string;
    simulated: true;
    ledgerEffect: "NONE";
  } | null;
};

export type FraudInvestigationResponse = { investigation: FraudInvestigation | null };

type ApiErrorBody = { error?: { code?: string; message?: string } };

export class BankingApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BankingApiError";
    this.status = status;
    this.code = code;
  }
}

export async function bankingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Keep the deliberately generic fallback for malformed upstream responses.
    }
    throw new BankingApiError(
      body.error?.message ?? "The fictional banking service is temporarily unavailable.",
      response.status,
      body.error?.code,
    );
  }

  return (await response.json()) as T;
}
