import type { Page, Request, Route } from "@playwright/test";

import type {
  ActivityResponse,
  BeneficiariesResponse,
  DashboardResponse,
  DemoLocation,
  DemoSessionResponse,
  FraudInvestigation,
  FraudInvestigationResponse,
  Payment,
  PaymentStatusResponse,
  PaymentSubmissionResponse,
} from "../../../lib/banking-api";
import type { Beneficiary, DemoCustomer, Transaction } from "../../../lib/demo-data";

export const customerIds = {
  alex: "cabcc662-0c08-5a82-b350-847e713ca3b7",
  priya: "cf874fb6-1429-5a1a-9538-961c82062156",
  daniel: "1a2cbd9a-b406-5b87-9dc0-d1dd9a51ae2c",
} as const;

const customers: DemoCustomer[] = [
  {
    id: customerIds.alex,
    slug: "alex-morgan",
    name: "Alex Morgan",
    firstName: "Alex",
    lastName: "Morgan",
    initials: "AM",
  },
  {
    id: customerIds.priya,
    slug: "priya-shah",
    name: "Priya Shah",
    firstName: "Priya",
    lastName: "Shah",
    initials: "PS",
  },
  {
    id: customerIds.daniel,
    slug: "daniel-evans",
    name: "Daniel Evans",
    firstName: "Daniel",
    lastName: "Evans",
    initials: "DE",
  },
];

const locations: Record<string, DemoLocation[]> = {
  [customerIds.alex]: [
    {
      id: "c3c5ed24-76cf-59de-b19f-b7fb9fa46a44",
      key: "usual-home",
      label: "Guildford · usual location",
      isUsual: true,
    },
    {
      id: "a0c58012-22bb-52eb-afab-5bb898a0e3a2",
      key: "lake-district",
      label: "Lake District · demo location",
      isUsual: false,
    },
  ],
  [customerIds.priya]: [
    {
      id: "84e859c5-e59c-509a-92f8-a1214d69932e",
      key: "usual-home",
      label: "Bristol · usual location",
      isUsual: true,
    },
  ],
  [customerIds.daniel]: [
    {
      id: "30e933c1-efb9-5d23-9c03-3bf27bfe847a",
      key: "usual-home",
      label: "Manchester · usual location",
      isUsual: true,
    },
  ],
};

const transactions: Record<string, Transaction[]> = {
  [customerIds.alex]: [
    {
      id: "alex-tx-1",
      name: "Whole Foods Market",
      date: "Today · 13:42",
      bookedAt: "2026-10-31T13:42:00.000Z",
      amount: -42.85,
      icon: "W",
      category: "Groceries",
    },
    {
      id: "alex-tx-2",
      name: "Pret A Manger",
      date: "Yesterday · 09:17",
      bookedAt: "2026-10-30T09:17:00.000Z",
      amount: -6.95,
      icon: "P",
      category: "Eating out",
    },
    {
      id: "alex-tx-3",
      name: "Salary · Fable Studio",
      date: "28 Oct · 08:30",
      bookedAt: "2026-10-28T08:30:00.000Z",
      amount: 3_250,
      icon: "↙",
      category: "Income",
    },
  ],
  [customerIds.priya]: [
    {
      id: "priya-tx-1",
      name: "Bristol Fruit Market",
      date: "Today · 11:05",
      bookedAt: "2026-10-31T11:05:00.000Z",
      amount: -18.4,
      icon: "B",
      category: "Groceries",
    },
  ],
  [customerIds.daniel]: [
    {
      id: "daniel-tx-1",
      name: "Northern Rail",
      date: "Yesterday · 17:10",
      bookedAt: "2026-10-30T17:10:00.000Z",
      amount: -31.2,
      icon: "N",
      category: "Transport",
    },
  ],
};

const initialBeneficiaries: Record<string, Beneficiary[]> = {
  [customerIds.alex]: [
    {
      id: "8e252606-f346-522c-a62e-bdd3aee2b45a",
      name: "Sam Bennett",
      sortCode: "04-09-41",
      accountNumber: "82645281",
      initials: "SB",
      recent: true,
      bookedPaymentCount: 2,
    },
    {
      id: "999b7354-9db7-588c-bd47-b710f18da32d",
      name: "Chloe Williams",
      sortCode: "20-16-25",
      accountNumber: "49018272",
      initials: "CW",
      recent: true,
      bookedPaymentCount: 1,
    },
  ],
  [customerIds.priya]: [
    {
      id: "a84baed3-3463-57ef-b117-301784823472",
      name: "Asha Patel",
      sortCode: "40-22-18",
      accountNumber: "30449172",
      initials: "AP",
      recent: true,
      bookedPaymentCount: 1,
    },
  ],
  [customerIds.daniel]: [],
};

const dashboards: Record<string, Omit<DashboardResponse, "recentTransactions">> = {
  [customerIds.alex]: {
    customer: customers[0],
    account: {
      id: "a4af9cb1-1c67-599b-93b6-a0233710941a",
      name: "Glaramara Current Account",
      sortCode: "04-11-20",
      accountNumber: "00007281",
      accountSuffix: "7281",
      currency: "GBP",
      availableBalance: 24_862.8,
      cardLastFour: "7281",
      balanceAsOf: "2026-10-31T13:42:00.000Z",
    },
    spending: [
      { category: "housing", label: "Home", amount: 1_200 },
      { category: "food", label: "Food & drink", amount: 312.4 },
      { category: "transport", label: "Transport", amount: 105.2 },
    ],
  },
  [customerIds.priya]: {
    customer: customers[1],
    account: {
      id: "924fe672-b930-5ee6-8af4-695c08d3f8ed",
      name: "Glaramara Current Account",
      sortCode: "04-11-20",
      accountNumber: "00003196",
      accountSuffix: "3196",
      currency: "GBP",
      availableBalance: 7_410.35,
      cardLastFour: "3196",
      balanceAsOf: "2026-10-31T11:05:00.000Z",
    },
    spending: [{ category: "food", label: "Food & drink", amount: 284.65 }],
  },
  [customerIds.daniel]: {
    customer: customers[2],
    account: {
      id: "d72a27b0-14e8-5c8f-8276-90a0a359c4a2",
      name: "Glaramara Current Account",
      sortCode: "04-11-20",
      accountNumber: "00004402",
      accountSuffix: "4402",
      currency: "GBP",
      availableBalance: 12_315.5,
      cardLastFour: "4402",
      balanceAsOf: "2026-10-30T17:10:00.000Z",
    },
    spending: [{ category: "transport", label: "Transport", amount: 192.8 }],
  },
};

export type CapturedMutation = {
  body: unknown;
  idempotencyKey?: string;
  origin: string | undefined;
  url: string;
};

export type MockBankingApi = {
  activeCustomerId: () => string;
  beneficiaryPosts: CapturedMutation[];
  paymentRequests: CapturedMutation[];
  sessionPosts: CapturedMutation[];
  investigationMutations: CapturedMutation[];
};

function cloneBeneficiaries(): Record<string, Beneficiary[]> {
  return Object.fromEntries(
    Object.entries(initialBeneficiaries).map(([customerId, items]) => [
      customerId,
      items.map((item) => ({ ...item })),
    ]),
  );
}

function capture(request: Request): CapturedMutation {
  let body: unknown = null;
  try {
    body = request.postDataJSON();
  } catch {
    body = request.postData();
  }
  return {
    body,
    idempotencyKey: request.headers()["idempotency-key"],
    origin: request.headers()["origin"],
    url: request.url(),
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
    status,
  });
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "B"}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

export async function mockPhaseABankingApi(page: Page): Promise<MockBankingApi> {
  let activeCustomerId: string = customerIds.alex;
  const beneficiaries = cloneBeneficiaries();
  const sessionPosts: CapturedMutation[] = [];
  const beneficiaryPosts: CapturedMutation[] = [];
  const paymentRequests: CapturedMutation[] = [];
  const investigationMutations: CapturedMutation[] = [];
  const payments = new Map<string, Payment>();
  let investigation: FraudInvestigation | null = null;

  const phaseCQuestions: FraudInvestigation["questions"] = [
    {
      id: "payment_recognition",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "Did you make this payment yourself?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "YES", label: "Yes, I made it" }, { value: "NO", label: "No" }],
      required: true,
    },
    {
      id: "beneficiary_relationship",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "How do you know the person or business you’re paying?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "KNOWN_PERSON", label: "Someone I know" }],
      required: true,
    },
    {
      id: "payment_purpose",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "What is this payment for?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "FRIENDS_FAMILY", label: "Friends or family" }],
      required: true,
    },
    {
      id: "contact_influence",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "Did anyone contact you or guide you through making this payment?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "UNEXPECTED", label: "Yes, an unexpected caller or message" }],
      required: true,
    },
    {
      id: "pressure_or_secrecy",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "Did they ask you to act quickly, keep it secret, or ignore a bank warning?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "YES", label: "Yes" }],
      required: true,
    },
    {
      id: "remote_access",
      version: "glaramara-fraud-questionnaire/1.0.0",
      prompt: "Did anyone ask you to install an app or share access to your phone or computer?",
      kind: "SINGLE_CHOICE",
      options: [{ value: "YES", label: "Yes" }],
      required: true,
    },
  ];

  function sessionResponse(): DemoSessionResponse {
    const customerLocations = locations[activeCustomerId];
    return {
      session: {
        customerId: activeCustomerId,
        demoLocationId: customerLocations[0].id,
        expiresAt: "2026-10-31T21:00:00.000Z",
      },
      customers,
      locations: customerLocations,
    };
  }

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/v1/demo/session") {
      if (method === "POST") {
        const mutation = capture(request);
        sessionPosts.push(mutation);
        const requestedId = (mutation.body as { customerId?: unknown } | null)?.customerId;
        if (typeof requestedId !== "string" || !customers.some((item) => item.id === requestedId)) {
          await json(
            route,
            { error: { code: "DEMO_CUSTOMER_NOT_FOUND", message: "Fictional customer not found." } },
            404,
          );
          return;
        }
        activeCustomerId = requestedId;
      }
      await json(route, sessionResponse());
      return;
    }

    if (url.pathname === "/api/v1/dashboard" && method === "GET") {
      const body: DashboardResponse = {
        ...dashboards[activeCustomerId],
        recentTransactions: transactions[activeCustomerId],
      };
      await json(route, body);
      return;
    }

    if (url.pathname === "/api/v1/activity" && method === "GET") {
      const body: ActivityResponse = { transactions: transactions[activeCustomerId] };
      await json(route, body);
      return;
    }

    if (url.pathname === "/api/v1/beneficiaries") {
      if (method === "POST") {
        const mutation = capture(request);
        beneficiaryPosts.push(mutation);
        const input = mutation.body as {
          accountNumber?: unknown;
          displayName?: unknown;
          sortCode?: unknown;
        };
        if (
          typeof input?.displayName !== "string" ||
          typeof input.sortCode !== "string" ||
          typeof input.accountNumber !== "string"
        ) {
          await json(route, { error: { code: "INVALID_REQUEST", message: "Invalid recipient." } }, 400);
          return;
        }
        const beneficiary: Beneficiary = {
          id: `playwright-beneficiary-${beneficiaryPosts.length}`,
          name: input.displayName,
          sortCode: input.sortCode,
          accountNumber: input.accountNumber,
          initials: initialsFor(input.displayName),
          recent: false,
          bookedPaymentCount: 0,
        };
        beneficiaries[activeCustomerId].push(beneficiary);
        await json(route, { beneficiary }, 201);
        return;
      }
      const body: BeneficiariesResponse = {
        beneficiaries: beneficiaries[activeCustomerId],
      };
      await json(route, body);
      return;
    }

    if (url.pathname === "/api/v1/payments" && method === "POST") {
      const mutation = capture(request);
      paymentRequests.push(mutation);
      const input = mutation.body as {
        amount?: unknown;
        beneficiaryId?: unknown;
        reference?: unknown;
      };
      const beneficiary = beneficiaries[activeCustomerId].find(
        (item) => item.id === input?.beneficiaryId,
      );
      if (
        !beneficiary ||
        typeof input.amount !== "string" ||
        typeof input.reference !== "string" ||
        !mutation.idempotencyKey
      ) {
        await json(route, { error: { code: "INVALID_REQUEST", message: "Invalid payment." } }, 400);
        return;
      }
      const existing = [...payments.values()].find(
        (payment) => payment.reference === input.reference && payment.beneficiary.id === beneficiary.id,
      );
      const payment: Payment = existing ?? {
        id: `00000000-0000-4000-8000-${String(paymentRequests.length).padStart(12, "0")}`,
        transactionId: `00000000-0000-4000-8000-${String(paymentRequests.length).padStart(12, "0")}`,
        beneficiary: { id: beneficiary.id, name: beneficiary.name },
        amount: Number(input.amount),
        currency: "GBP",
        reference: input.reference,
        status: "PENDING",
        submittedAt: "2026-11-01T12:00:00.000Z",
        eventTime: "2026-11-01T12:00:00.000Z",
        simulated: true,
        ledgerEffect: "NONE",
        processing: {
          publicationStatus: "PENDING",
          attempts: 0,
          lastErrorType: null,
          publishedAt: null,
          delayed: false,
        },
        authoritativeDecision: null,
        correlation: null,
        experimentalShadow: null,
      };
      payments.set(payment.id, payment);
      const response: PaymentSubmissionResponse = { payment, replayed: Boolean(existing) };
      await json(route, response, existing ? 200 : 202);
      return;
    }

    const investigationMatch = url.pathname.match(
      /^\/api\/v1\/payments\/([0-9a-f-]+)\/investigation(?:\/(answers|extract))?$/,
    );
    if (investigationMatch) {
      if (method === "GET") {
        const response: FraudInvestigationResponse = { investigation };
        await json(route, response);
        return;
      }
      const mutation = capture(request);
      investigationMutations.push(mutation);
      if (!investigationMatch[2]) {
        investigation = {
          id: "10000000-0000-4000-8000-000000000001",
          paymentId: investigationMatch[1],
          status: "IN_PROGRESS",
          questionnaireVersion: "glaramara-fraud-questionnaire/1.0.0",
          questions: phaseCQuestions.slice(0, 4),
          answers: {},
          currentQuestionId: "payment_recognition",
          answeredCount: 0,
          selectedQuestionCount: 4,
          agentInvocationCount: 0,
          canExtract: false,
          resolution: null,
        };
        await json(route, { investigation }, 201);
        return;
      }
      if (!investigation) {
        await json(route, { error: { code: "INVESTIGATION_NOT_FOUND", message: "Not found." } }, 404);
        return;
      }
      if (investigationMatch[2] === "answers") {
        const input = mutation.body as { questionId: string; answer: { value: string } };
        investigation.answers[input.questionId] = {
          value: input.answer.value,
          answeredAt: "2026-11-02T09:00:00.000Z",
          source: "DEFINITION",
        };
        if (input.questionId === "contact_influence" && input.answer.value === "UNEXPECTED") {
          investigation.questions = phaseCQuestions;
          investigation.selectedQuestionCount = phaseCQuestions.length;
        }
        investigation.answeredCount = Object.keys(investigation.answers).length;
        investigation.currentQuestionId = investigation.questions.find(
          (question) => !investigation?.answers[question.id],
        )?.id ?? null;
        if (!investigation.currentQuestionId) {
          investigation.status = "READY_FOR_EXTRACTION";
          investigation.canExtract = true;
        }
        await json(route, { investigation });
        return;
      }
      investigation.status = "REASSESSED";
      investigation.agentInvocationCount = 1;
      investigation.canExtract = false;
      investigation.resolution = {
        outcome: "DECLINED",
        policyVersion: "customer-evidence-reassessment/1.0.0",
        reasonCodes: ["DEFINED_SCAM_INDICATOR"],
        reassessedAt: "2026-11-02T09:00:01.000Z",
        simulated: true,
        ledgerEffect: "NONE",
      };
      await json(route, { investigation });
      return;
    }

    if (url.pathname.startsWith("/api/v1/payments/") && method === "GET") {
      const payment = payments.get(url.pathname.split("/").at(-1) ?? "");
      if (!payment) {
        await json(route, { error: { code: "PAYMENT_NOT_FOUND", message: "Payment not found." } }, 404);
        return;
      }
      const response: PaymentStatusResponse = { payment };
      await json(route, response);
      return;
    }

    await json(route, { error: { code: "NOT_MOCKED", message: "Unexpected API request." } }, 500);
  });

  return {
    activeCustomerId: () => activeCustomerId,
    beneficiaryPosts,
    paymentRequests,
    sessionPosts,
    investigationMutations,
  };
}
