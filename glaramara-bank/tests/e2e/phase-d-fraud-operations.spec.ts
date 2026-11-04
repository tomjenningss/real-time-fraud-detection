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
  activeDatasetId: "a5d67ed2-e42c-5dcb-8e75-765b36d8299a",
  datasets: [{
    id: "a5d67ed2-e42c-5dcb-8e75-765b36d8299a", generatorVersion: "fraud-lab-generator/1.0.1",
    seed: "20261102", requestedTransactionCount: 8000, actualTransactionCount: 8000,
    fraudScenarioId: "multi_new_beneficiary", status: "READY", contentSha256: "a".repeat(64),
    requestedAt: "2026-11-02T10:00:00.000Z", generatedAt: "2026-11-02T10:00:00.000Z",
    failureCode: null, active: true,
  }],
  dataset: { totalTransactions: 14000, fraudLabelled: 252, baselineFraudDetected: 44, baselineCoverage: 44 / 252 },
  waves: [
    { id: "fraud-lab-wave-2026q4-v1", rowCount: 8000, discoveryCount: 5600, evaluationCount: 2400, seed: 20261102, contentSha256: "a".repeat(64) },
    { id: "fraud-lab-wave-2027q1-v2", rowCount: 6000, discoveryCount: 4200, evaluationCount: 1800, seed: 20270115, contentSha256: "d".repeat(64) },
  ],
  runs: [{
    id: "1dec13bd-18cb-40a9-ab59-e6d4166cf0c6",
    status: "COMPLETED",
    snapshotRowCount: 8000,
    startedAt: "2026-11-02T17:55:00.000Z",
    finishedAt: "2026-11-02T17:55:08.000Z",
    candidateId: "d3bfc928-05d4-43f8-b54b-3fb55b4cc2b6",
    ruleName: "High amount with multiple merchants in short window",
    candidateStatus: "BACKTESTED",
  }],
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
  await page.route("**/api/v1/fraud-operations/runs/*", (route) => {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: runDetail() }) });
  });
  await page.route("**/api/v1/fraud-operations/candidates/*/reviews", (route) => {
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ run: runDetail(true) }) });
  });

  await page.goto("/fraud-operations");
  await expect(page.getByRole("heading", { name: "Fraud Operations" })).toBeVisible();
  await expect(page.getByText("14,000 transactions", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SYNTHETIC FRAUD LAB · HUMAN DECISION REQUIRED")).toBeVisible();
  await expect(page.getByRole("heading", { name: "High amount with multiple merchants in short window" })).toBeVisible();

  await page.getByRole("button", { name: "Run new analysis" }).click();
  await expect(page.getByRole("status")).toContainText("immutable snapshot");
  await expect(page.getByRole("heading", { name: "High amount with multiple merchants in short window" })).toBeVisible();
  await expect(page.getByText(/Immutable investigation: 8,000 transactions/)).toBeVisible();
  await expect(page.getByText(/Current active dataset: 14,000 transactions/).last()).toBeVisible();
  await expect(page.getByText("Additional fraud detected").first()).toBeVisible();
  await expect(page.getByText("Additional legitimate challenged", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel(/Fraud recall comparison\. Baseline 16\.9%, with proposed rule 20\.3%, improvement \+3\.4 percentage points/)).toBeVisible();
  await expect(page.getByLabel(/Fraud detection versus customer friction\. 5 additional fraud-labelled payments detected and 2 additional legitimate payments challenged/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Emerging pattern", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Detection gap", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposed rule", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Independent backtest", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Human analyst decision", exact: true })).toBeVisible();
  await expect(page.getByText("GENERATED BY WATSONX ORCHESTRATE")).toBeVisible();
  await expect(page.getByText("CALCULATED DETERMINISTICALLY BY GLARAMARA")).toBeVisible();
  await page.getByLabel("Toggle System View technical evidence").check();
  await expect(page.getByText("Proposed Flink implementation")).toBeVisible();
  await expect(page.getByText("PROPOSED — NOT DEPLOYED").first()).toBeVisible();
  await expect(page.getByText("Suggested fraud signal")).toBeHidden();
  await page.getByText("Technical evidence and provenance").click();
  await expect(page.getByText(/watsonx-orchestrate-rest/)).toBeVisible();

  await page.getByLabel("Optional review rationale").fill("Measured improvement");
  await page.getByRole("button", { name: "Approve for future engineering" }).click();
  await expect(page.getByText("Approved for future engineering. No live fraud detection controls have been changed.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= Math.ceil(window.innerWidth) + 1)).toBe(true);
});

test("generates and explicitly activates data without starting analysis", async ({ context, page }) => {
  await context.addCookies([{ name: "glaramara_demo_session", value: analystSessionToken(), url: "http://127.0.0.1:3100", httpOnly: true, sameSite: "Lax" }]);
  const current = structuredClone(dashboard);
  let analysisRequests = 0;
  await page.route("**/api/v1/fraud-operations", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(current),
  }));
  await page.route("**/api/v1/fraud-operations/datasets", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(await route.request().postDataJSON()).toEqual({ transactionCount: 10000 });
    const generated = {
      ...current.datasets[0], id: "d5376eed-fce1-43b9-9ffb-70d20a97022f", seed: "123456789",
      requestedTransactionCount: 10000, actualTransactionCount: 10000, status: "READY" as const,
      contentSha256: "e".repeat(64), active: false,
    };
    current.datasets.unshift(generated);
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ dataset: generated }) });
  });
  await page.route("**/api/v1/fraud-operations/datasets/*/activate", async (route) => {
    expect(await route.request().postDataJSON()).toEqual({ confirmation: "ACTIVATE" });
    current.datasets.forEach((dataset) => { dataset.active = dataset.id === "d5376eed-fce1-43b9-9ffb-70d20a97022f"; });
    current.activeDatasetId = "d5376eed-fce1-43b9-9ffb-70d20a97022f";
    current.dataset.totalTransactions = 10000;
    current.waves = [{ ...current.waves[0], id: "fraud-lab-wave-dataset-d5376eedfce143b99ffb70d20a97022f", rowCount: 10000, discoveryCount: 7000, evaluationCount: 3000 }];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dataset: current.datasets[0] }) });
  });
  await page.route("**/api/v1/fraud-operations/analyses", (route) => {
    analysisRequests += 1;
    return route.abort();
  });

  await page.goto("/fraud-operations");
  await expect(page.getByRole("heading", { name: "Generate data, then choose when to analyse it" })).toBeVisible();
  await page.getByText("10,000 transactions", { exact: true }).click();
  await page.getByRole("button", { name: "Generate new dataset" }).click();
  await expect(page.getByText(/10,000 · Ready/)).toBeVisible();
  await page.getByText("Confirm activation for future investigations.").click();
  await page.getByRole("button", { name: "Activate completed dataset" }).click();
  await expect(page.getByText("10,000 transactions", { exact: true }).first()).toBeVisible();
  expect(analysisRequests).toBe(0);
});
