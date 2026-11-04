import { expect, test } from "@playwright/test";

import type {
  FraudIntelligenceView,
  InvestigationStage,
  InvestigationStageId,
} from "../../lib/fraud-intelligence-view";
import { mockPhaseABankingApi } from "./support/mock-banking-api";

const stageDefinitions: Array<[InvestigationStageId, string, InvestigationStage["lane"], InvestigationStage["authority"]]> = [
  ["payment_submitted", "Payment submitted", "INGESTION", "TRANSPORT"],
  ["postgres_outbox", "Transactional outbox", "INGESTION", "TRANSPORT"],
  ["kafka", "Kafka event stream", "INGESTION", "TRANSPORT"],
  ["flink_enrichment", "Event-time enrichment", "INGESTION", "TRANSPORT"],
  ["authoritative_policy", "Authoritative router policy", "AUTHORITATIVE", "AUTHORITATIVE"],
  ["lightgbm_shadow", "LightGBM scorer", "SHADOW", "SHADOW_ONLY"],
  ["go_correlation", "Evidence correlator", "SHADOW", "SHADOW_ONLY"],
  ["go_shadow_policy", "Shadow decision engine", "SHADOW", "SHADOW_ONLY"],
  ["customer_questionnaire", "Security questionnaire", "REASSESSMENT", "SIMULATED"],
  ["fraud_intelligence_provider", "watsonx Orchestrate", "REASSESSMENT", "SIMULATED"],
  ["structured_evidence", "Structured evidence", "REASSESSMENT", "SIMULATED"],
  ["governed_reassessment", "Governed reassessment", "REASSESSMENT", "SIMULATED"],
  ["simulated_outcome", "Simulated outcome", "REASSESSMENT", "SIMULATED"],
  ["customer_guidance", "Prevention guidance", "REASSESSMENT", "SIMULATED"],
];

function fixture(paymentId: string): FraudIntelligenceView {
  const started = Date.parse("2026-11-02T12:00:00.000Z");
  const stages = stageDefinitions.map(([id, label, lane, authority], index): InvestigationStage => ({
    id,
    component: id === "fraud_intelligence_provider" ? "IBM" : id.split("_")[0],
    label,
    lane,
    authority,
    status: "COMPLETE",
    observation: "DIRECT",
    summary: id === "authoritative_policy"
      ? "CHALLENGED is the immutable customer-facing verdict."
      : `${label} completed from persisted evidence.`,
    occurredAt: new Date(started + index * 500).toISOString(),
    observedAt: new Date(started + index * 500 + 20).toISOString(),
    durationMs: 12,
    evidenceReferences: [`test:${id}`],
    details: id === "fraud_intelligence_provider" ? {
      humanSummary: [
        "Payment recognition: recognised.",
        "Payment purpose: goods or services.",
        "Contracted uncertainty: low.",
      ],
      provider: "watsonx-orchestrate-rest",
      model: "test-model",
      latencyMs: 214,
      provenance: [{
        findingId: "paymentPurpose",
        claim: "payment purpose is goods or services",
        sources: [{ questionId: "payment_circumstances", excerpt: "I’m paying a builder." }],
      }],
      structuredResponse: {
        schemaVersion: "fraud-intelligence-evidence/1.1.0",
        paymentRecognition: "RECOGNISED",
        beneficiaryRelationship: "NEW",
        paymentPurpose: "GOODS_OR_SERVICES",
        thirdPartyInfluence: "NONE",
        verificationClaims: ["INVOICE_RECEIVED"],
        uncertainty: "LOW",
      },
      contribution: {
        customerExplanation: "I’m paying a builder.",
        extractedFindings: {
          paymentRecognition: "RECOGNISED",
          beneficiaryRelationship: "NEW",
          paymentPurpose: "GOODS_OR_SERVICES",
          thirdPartyInfluence: "NONE",
          verificationClaims: ["INVOICE_RECEIVED"],
          uncertainty: "LOW",
        },
        fraudIndicators: ["NONE"],
        evidenceProvenance: [{
          findingId: "paymentPurpose",
          claim: "payment purpose is goods or services",
          sources: [{ questionId: "payment_circumstances", excerpt: "I’m paying a builder." }],
        }],
        matchedDeterministicRules: [{
          ruleId: "CER-ADDITIONAL-VERIFY-NARROW-SERVICE-PAYMENT",
          summary: "Independent beneficiary verification remains mandatory.",
          conditions: [{ condition: "purpose is goods or services", actual: "GOODS_OR_SERVICES" }],
        }],
        simulatedAction: "ADDITIONAL_VERIFICATION",
        authoritativeVerdict: "CHALLENGED",
        ledgerEffect: "NONE",
      },
    } : id === "customer_guidance" ? {
      contractVersion: "fraud-prevention-guidance/1.0.0",
      persisted: true,
      regeneratedOnReplay: false,
      guidance: {
        contractVersion: "fraud-prevention-guidance/1.0.0",
        category: "SERVICE_PAYMENT_ADDITIONAL_VERIFICATION",
        simulatedOutcome: "ADDITIONAL_VERIFICATION",
        personalised: true,
        customerStatement: "I’m paying a builder.",
        evidenceFindingIds: ["paymentPurpose", "verificationClaim:INVOICE_RECEIVED"],
        evidenceProvenance: [],
        templateReferences: [{ templateId: "service-payment-independent-verification", version: "1.0.0" }],
        rendered: {
          heading: "Let’s independently verify the beneficiary",
          context: "Customer-reported checks do not establish that the beneficiary account is safe.",
          steps: [
            "Contact the business using independently sourced details.",
            "Confirm the account details through that trusted channel.",
            "Wait for the independent beneficiary check.",
          ],
          paymentStatus: "This payment needs independent verification. No money has been sent.",
          reviewMessage: "No callback or payment release has been scheduled.",
          simulationNotice: "This is a simulated payment. Your balance has not changed.",
        },
      },
    } : { persisted: true },
    rawJson: null,
  }));
  return {
    schemaVersion: "fraud-investigation-view/1.0.0",
    generatedAt: new Date().toISOString(),
    paymentId,
    transactionId: paymentId,
    authoritativeVerdict: "CHALLENGED",
    stages,
    timeline: stages.map((stage, index) => ({
      id: `event:${stage.id}`,
      stageId: stage.id,
      status: "COMPLETE",
      occurredAt: new Date(started + index * 500).toISOString(),
      observedAt: new Date(started + index * 500 + 20).toISOString(),
      label: `${stage.label} completed`,
      evidenceReference: `test:${stage.id}`,
    })),
  };
}

test("persists system view and reveals read-only evidence below the customer response", async ({ page }) => {
  const api = await mockPhaseABankingApi(page);
  await page.route("**/api/v1/payments/*/fraud-intelligence", async (route) => {
    const paymentId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    await route.fulfill({
      body: JSON.stringify({ investigation: fixture(paymentId) }),
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
    });
  });

  await page.goto("/payments");
  await page.getByRole("button", { name: /Sam Bennett/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();
  await page.getByRole("button", { name: "Review payment →" }).click();
  await page.getByRole("button", { name: "Send payment" }).click();

  const toggle = page.getByRole("checkbox", { name: /System view/ });
  await expect(page.getByRole("heading", { name: "We’re checking this payment" })).toBeVisible();
  await expect(page.getByText("Fraud decision breakdown", { exact: true })).toHaveCount(0);
  await toggle.check();
  await expect(page.getByRole("heading", { name: "We’re checking this payment" })).toBeVisible();
  const breakdown = page.getByText("Fraud decision breakdown", { exact: true });
  await expect(breakdown).toBeVisible();
  await breakdown.click();
  for (const heading of ["Apache Flink", "Deterministic router", "LightGBM", "Go correlator", "watsonx Orchestrate", "Payment outcome"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("fraud-decision-breakdown").getByText("SHADOW ONLY", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("fraud-decision-breakdown").getByText("CHALLENGED", { exact: true }).last()).toBeVisible();

  await expect(page.getByRole("heading", { name: "System investigation" })).toBeVisible();
  await expect(page.getByTestId("fraud-architecture-diagram")).toBeVisible();
  await expect(page.locator(".system-flow-particle").first()).toBeVisible();
  await page.getByText("Architecture flow", { exact: true }).click();
  await expect(page.getByTestId("fraud-architecture-diagram")).toBeHidden();
  await page.getByText("Architecture flow", { exact: true }).click();
  await expect(page.getByTestId("fraud-architecture-diagram")).toBeVisible();

  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Fraud decision breakdown", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "We’re checking this payment" })).toBeVisible();
  expect(api.paymentRequests).toHaveLength(1);
  expect(api.investigationMutations).toHaveLength(0);
});
