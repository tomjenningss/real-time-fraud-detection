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
      humanSummary: ["Payment recognition: recognised.", "Contracted uncertainty: low."],
      provider: "watsonx-orchestrate-rest",
      model: "test-model",
      latencyMs: 214,
      provenance: [{ claim: "payment recognised", sourceQuestionIds: ["payment_recognition"] }],
      structuredResponse: { schemaVersion: "fraud-intelligence-evidence/1.0.0", uncertainty: "LOW" },
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

test("persists system view and performs animated read-only replay", async ({ page }) => {
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
  await page.getByRole("button", { name: "Submit fictional payment" }).click();

  const toggle = page.getByRole("checkbox", { name: /System view/ });
  await toggle.check();
  await expect(page.getByRole("heading", { name: "System investigation" })).toBeVisible();
  await expect(page.getByTestId("fraud-architecture-diagram")).toBeVisible();
  await expect(page.locator(".system-flow-particle").first()).toBeVisible();

  await page.getByRole("button", { name: /Replay investigation/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.getByLabel("Speed").selectOption("4");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Restart" }).click();

  await page.getByRole("button", { name: /watsonx Orchestrate: complete/ }).click();
  await expect(page.getByText("VALIDATED FINDINGS")).toBeVisible();
  await expect(page.getByText("Payment recognition: recognised.")).toBeVisible();
  await page.getByRole("button", { name: /Close evidence details/ }).click();

  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("heading", { name: "System investigation" })).toBeVisible();
  expect(api.paymentRequests).toHaveLength(1);
  expect(api.investigationMutations).toHaveLength(0);
});
