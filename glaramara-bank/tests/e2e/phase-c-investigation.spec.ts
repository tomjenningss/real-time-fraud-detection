import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import { mockPhaseABankingApi } from "./support/mock-banking-api";

const paymentId = "76608ed5-27de-4441-b459-ec2b68f4aa8f";

async function selectAndContinue(page: Page, label: string) {
  await page.getByLabel(label, { exact: true }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();
}

async function completeLowRiskQuestionnaire(page: Page) {
  await page.goto(`/payments/investigation?paymentId=${paymentId}`);
  await page.getByRole("button", { name: /Start check/ }).click();
  await selectAndContinue(page, "Yes, I made it");
  await selectAndContinue(page, "Someone I know");
  await selectAndContinue(page, "Friends or family");
  await selectAndContinue(page, "No, nobody guided me");
  await page.getByRole("textbox").fill("I am paying a family member for our shared holiday booking.");
  await page.getByRole("button", { name: "Save and continue" }).click();
}

test("adapts, recovers and completes the Phase C investigation accessibly", async ({ page }) => {
  const api = await mockPhaseABankingApi(page, { extractionDelayMs: 300 });
  await page.goto(`/payments/investigation?paymentId=${paymentId}`);

  await expect(page.getByRole("heading", { name: "A quick security check" })).toBeVisible();
  await page.getByRole("button", { name: /Start check/ }).click();
  await selectAndContinue(page, "Yes, I made it");
  await selectAndContinue(page, "Someone I know");

  await page.reload();
  await expect(page.getByRole("group", { name: "What is this payment for?" })).toBeVisible();
  await selectAndContinue(page, "Friends or family");
  await selectAndContinue(page, "Yes, an unexpected caller or message");

  await expect(page.getByText("5 of about 7", { exact: true })).toBeVisible();
  await page.getByRole("textbox").fill(
    "An unfamiliar number said my daughter abroad needed urgent help and told me to pay an unknown beneficiary.",
  );
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("6 of about 7", { exact: true })).toBeVisible();
  await selectAndContinue(page, "Yes");
  await expect(page.getByRole("group", { name: /install an app or share access/ })).toBeVisible();
  await selectAndContinue(page, "Yes");
  await expect(page.getByRole("heading", { name: "We’re reviewing your payment" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "We can’t approve this payment" })).toBeVisible();
  await expect(page.getByText("This was a simulated payment. Your balance has not changed.")).toBeVisible();
  expect(api.investigationMutations).toHaveLength(8);
  expect(api.investigationMutations.filter((item) => item.idempotencyKey)).toHaveLength(7);
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= Math.ceil(window.innerWidth) + 1,
  )).toBe(true);

  const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"];
  const results = await new AxeBuilder({ page: axePage }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const violations = results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target.join(" ")),
  }));
  expect(violations).toEqual([]);
});

test("automatically completes a successful review", async ({ page }) => {
  const api = await mockPhaseABankingApi(page, { extractionDelayMs: 250, outcome: "CLEARED" });

  await completeLowRiskQuestionnaire(page);

  await expect(page.getByRole("heading", { name: "We’re reviewing your payment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security check complete" })).toBeVisible();
  expect(api.investigationMutations.filter((item) => item.url.endsWith("/extract"))).toHaveLength(0);
});

test("fails safely when the automatic review is unavailable", async ({ page }) => {
  await mockPhaseABankingApi(page, { extractionDelayMs: 250, extractionFailure: true });

  await completeLowRiskQuestionnaire(page);

  await expect(page.getByRole("heading", { name: "We’re reviewing your payment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "We couldn’t finish the review" })).toBeVisible();
  await expect(page.getByText(/has not been approved and no money has moved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("treats a duplicate answer submission as the same saved answer", async ({ page }) => {
  const api = await mockPhaseABankingApi(page);
  await page.goto(`/payments/investigation?paymentId=${paymentId}`);
  await page.getByRole("button", { name: /Start check/ }).click();

  const statuses = await page.evaluate(async ({ id }) => {
    const submit = () => fetch(`/api/v1/payments/${id}/investigation/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "duplicate-answer" },
      body: JSON.stringify({ questionId: "payment_recognition", answer: { value: "YES" } }),
    });
    const first = await submit();
    const replay = await submit();
    return [first.status, replay.status];
  }, { id: paymentId });

  expect(statuses).toEqual([200, 200]);
  expect(api.investigationMutations.filter((item) => item.idempotencyKey === "duplicate-answer"))
    .toHaveLength(2);
  await page.reload();
  await expect(page.getByRole("group", { name: /How do you know/ })).toBeVisible();
});

test("recovers an in-progress automatic review after browser refresh", async ({ page }) => {
  const api = await mockPhaseABankingApi(page, { extractionDelayMs: 1_200, outcome: "CLEARED" });

  await completeLowRiskQuestionnaire(page);
  await expect(page.getByRole("heading", { name: "We’re reviewing your payment" })).toBeVisible();
  await page.reload();

  await expect(page.getByRole("heading", { name: "We’re reviewing your payment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Security check complete" })).toBeVisible();
  expect(api.investigationMutations.filter((item) => item.url.endsWith("/extract"))).toHaveLength(0);
});
