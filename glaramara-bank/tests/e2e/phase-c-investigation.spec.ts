import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import { mockPhaseABankingApi } from "./support/mock-banking-api";

const paymentId = "76608ed5-27de-4441-b459-ec2b68f4aa8f";

async function selectAndContinue(page: Page, label: string) {
  await page.getByLabel(label, { exact: true }).check();
  await page.getByRole("button", { name: "Save and continue" }).click();
}

test("adapts, recovers and completes the Phase C investigation accessibly", async ({ page }) => {
  const api = await mockPhaseABankingApi(page);
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
  await expect(page.getByRole("heading", { name: "Your answers are ready" })).toBeVisible();
  await page.getByRole("button", { name: "Analyse my answers" }).click();

  await expect(page.getByRole("heading", { name: "Payment remains declined" })).toBeVisible();
  await expect(page.getByText(/original CHALLENGED verdict is immutable/)).toBeVisible();
  expect(api.investigationMutations).toHaveLength(9);
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
