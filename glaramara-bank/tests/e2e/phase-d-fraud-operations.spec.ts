import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

const sessionSecret = "phase-b-playwright-only-session-secret-000000000000";
const analyst = {
  id: "fraud-analyst-alex-morgan",
  slug: "fraud-analyst-alex-morgan",
  name: "Alex Morgan — Fraud Analyst",
  firstName: "Alex",
  lastName: "Morgan",
  initials: "AM",
  role: "FRAUD_ANALYST",
};

function analystSessionToken() {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    role: "FRAUD_ANALYST",
    analystId: analyst.id,
    reviewerName: "Alex Morgan",
    iat,
    exp: iat + 8 * 60 * 60,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

const dashboard = {
  synthetic: true,
  dataset: { totalTransactions: 14000, fraudLabelled: 252, baselineFraudDetected: 44, baselineCoverage: 44 / 252 },
  waves: [
    { id: "fraud-lab-wave-2026q4-v1", rowCount: 8000, discoveryCount: 5600, evaluationCount: 2400, seed: 20261102, contentSha256: "a".repeat(64) },
    { id: "fraud-lab-wave-2027q1-v2", rowCount: 6000, discoveryCount: 4200, evaluationCount: 1800, seed: 20270115, contentSha256: "d".repeat(64) },
  ],
  runs: [],
};

function runDetail(reviewed = false) {
  return {
    id: "1dec13bd-18cb-40a9-ab59-e6d4166cf0c6",
    status: "COMPLETED",
    snapshot: { waves: dashboard.waves },
    snapshotSha256: "b".repeat(64),
    snapshotRowCount: 8000,
    errorType: null,
    agent: { provider: "watsonx-orchestrate-rest", model: "groq/openai/gpt-oss-120b", agentId: "agent-1", latencyMs: 6082 },
    candidate: {
      id: "d3bfc928-05d4-43f8-b54b-3fb55b4cc2b6",
      fingerprint: "c".repeat(64),
      duplicateOfCandidateId: null,
      status: reviewed ? "APPROVED_FOR_IMPLEMENTATION" : "BACKTESTED",
      proposal: {
        name: "High amount with multiple merchants in short window",
        description: "Challenges short bursts that combine material value with merchant diversity.",
        rationale: "Discovery evidence shows fraud-labelled misses concentrated in this bounded cohort.",
        action: "CHALLENGED",
        uncertainty: "MEDIUM",
        conditions: [
          { featureId: "amount_gbp", operator: "GTE", threshold: 100, window: null },
          { featureId: "customer_distinct_merchant_count", operator: "GTE", threshold: 4, window: "PT2M" },
        ],
        supportingEvidenceRefs: ["cohort:velocity-value"],
        limitations: ["Legitimate shopping bursts can look similar."],
      },
      backtest: {
        evaluatorVersion: "fraud-rule-evaluator/1.0.0",
        metrics: {
          baseline: { truePositives: 25, falsePositives: 7, trueNegatives: 2245, falseNegatives: 123, precision: 0.78125, recall: 0.1689 },
          candidate: { truePositives: 14, falsePositives: 6, trueNegatives: 2246, falseNegatives: 134, precision: 0.7, recall: 0.0946 },
          combined: { truePositives: 30, falsePositives: 9, trueNegatives: 2243, falseNegatives: 118, precision: 0.7692, recall: 0.2027 },
          additionalFraudDetected: 5,
          additionalLegitimateChallenged: 2,
          overlapWithBaseline: 13,
        },
        examples: { additionalFraud: ["tx:f1"], falsePositives: ["tx:g1"], overlap: ["tx:o1"] },
        semanticsNote: "Ordered batch semantics; no Flink watermark simulation.",
      },
      review: reviewed ? { decision: "APPROVED_FOR_IMPLEMENTATION", reason: "Measured improvement", reviewedAt: "2026-11-02T17:55:32.054Z" } : null,
    },
  };
}

test("analyses and approves a synthetic rule responsively without claiming deployment", async ({ context, page }) => {
  await context.addCookies([{ name: "glaramara_demo_session", value: analystSessionToken(), url: "http://127.0.0.1:3100", httpOnly: true, sameSite: "Lax" }]);
  await page.route("**/api/v1/demo/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ session: { customerId: analyst.id, demoLocationId: null, role: "FRAUD_ANALYST", expiresAt: "2026-11-03T01:00:00Z" }, customer: analyst, customers: [analyst], locations: [] }),
  }));
  await page.route("**/api/v1/fraud-operations", (route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboard) });
  });
  await page.route("**/api/v1/fraud-operations/analyses", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: runDetail() }) });
  });
  await page.route("**/api/v1/fraud-operations/candidates/*/reviews", (route) => {
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: runDetail(true) }) });
  });

  await page.goto("/fraud-operations");
  await expect(page.getByRole("heading", { name: "Fraud Operations" })).toBeVisible();
  await expect(page.getByText("14,000 transactions", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SYNTHETIC FRAUD LAB · HUMAN APPROVAL REQUIRED")).toBeVisible();

  await page.getByRole("button", { name: "Analyse fraud patterns" }).click();
  await expect(page.getByRole("status")).toContainText("immutable snapshot");
  await expect(page.getByRole("heading", { name: "High amount with multiple merchants in short window" })).toBeVisible();
  await expect(page.getByText(/Historical analysis snapshot: 8,000 transactions/)).toBeVisible();
  await expect(page.getByText(/Current active dataset: 14,000 transactions/).last()).toBeVisible();
  await expect(page.getByText("Additional fraud detected")).toBeVisible();
  await expect(page.getByText("Additional genuine challenged")).toBeVisible();
  await expect(page.getByText(/watsonx-orchestrate-rest/)).toBeVisible();

  await page.getByLabel("Optional review reason").fill("Measured improvement");
  await page.getByRole("button", { name: "Approve for implementation" }).click();
  await expect(page.getByText("Rule approved for future implementation. No live fraud detection controls have been changed.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.innerWidth) + 1)).toBe(true);
});
