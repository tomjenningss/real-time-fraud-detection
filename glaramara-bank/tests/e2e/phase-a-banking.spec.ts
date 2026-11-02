import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { customerIds, mockPhaseABankingApi } from "./support/mock-banking-api";

function isMobileProject(projectName: string) {
  return projectName === "mobile-chrome";
}

test("renders the approved forest-green bank shell and responsive navigation", async ({ page }, testInfo) => {
  await mockPhaseABankingApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Good evening, Alex/ })).toBeVisible();
  await expect(page.getByText("£24,862.80", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Glaramara mountain mark" })).toBeVisible();
  await expect(page.getByText("INTERACTIVE DEMO", { exact: true })).toBeVisible();

  await expect
    .poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(245, 247, 243)");

  const accountCard = page.locator("section").filter({ hasText: "Available balance" }).first();
  const accountBackground = await accountCard.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  expect(accountBackground).toContain("rgb(19, 57, 46)");

  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  const mobile = isMobileProject(testInfo.project.name);

  if (mobile) {
    await expect(primaryNavigation).toBeHidden();
    await expect(mobileNavigation).toBeVisible();
    await expect(page.locator("#mobile-customer")).toBeVisible();
  } else {
    await expect(primaryNavigation).toBeVisible();
    await expect(mobileNavigation).toBeHidden();
    await expect(page.getByText("glaramara.", { exact: true })).toBeVisible();
    await expect(page.locator("#desktop-customer")).toBeVisible();
  }

  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= Math.ceil(window.innerWidth) + 1,
      ),
    )
    .toBe(true);

  const activeNavigation = mobile ? mobileNavigation : primaryNavigation;
  await activeNavigation.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your activity/ })).toBeVisible();
  await expect(page.getByText("Whole Foods Market", { exact: true })).toBeVisible();
  await expect(page.getByText("All accounts, transactions and decisions are fictional.")).toBeVisible();
});

test("switches fictional customers through the same-origin session API", async ({ page }, testInfo) => {
  const bankingApi = await mockPhaseABankingApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Good evening, Alex/ })).toBeVisible();
  const switcher = page.locator(
    isMobileProject(testInfo.project.name) ? "#mobile-customer" : "#desktop-customer",
  );
  await switcher.selectOption(customerIds.priya);

  await expect(page.getByRole("heading", { name: /Good evening, Priya/ })).toBeVisible();
  await expect(page.getByText("£7,410.35", { exact: true })).toBeVisible();
  await expect(page.getByText("Bristol Fruit Market", { exact: true })).toBeVisible();
  expect(bankingApi.activeCustomerId()).toBe(customerIds.priya);
  expect(bankingApi.sessionPosts).toHaveLength(1);
  expect(bankingApi.sessionPosts[0].body).toEqual({ customerId: customerIds.priya });
  expect(bankingApi.sessionPosts[0].origin).toBe(new URL(bankingApi.sessionPosts[0].url).origin);
});

test("persists a fictional beneficiary through the mocked Phase A contract", async ({ page }) => {
  const bankingApi = await mockPhaseABankingApi(page);
  await page.goto("/beneficiaries");

  await expect(page.getByRole("heading", { name: /Your beneficiaries/ })).toBeVisible();
  await expect(page.getByText("Sam Bennett", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add recipient" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Lakeview Property Ltd");
  await page.getByLabel("Sort code", { exact: true }).fill("20-44-83");
  await page.getByLabel("Account number", { exact: true }).fill("00218459");
  await page.getByRole("button", { name: "Save fictional recipient" }).click();

  await expect(page.getByText("Lakeview Property Ltd", { exact: true })).toBeVisible();
  await expect(page.getByText(/New beneficiary · •••• 8459/)).toBeVisible();
  expect(bankingApi.beneficiaryPosts).toHaveLength(1);
  expect(bankingApi.beneficiaryPosts[0].body).toEqual({
    accountNumber: "00218459",
    displayName: "Lakeview Property Ltd",
    sortCode: "20-44-83",
  });
  expect(bankingApi.beneficiaryPosts[0].origin).toBe(
    new URL(bankingApi.beneficiaryPosts[0].url).origin,
  );
});

test("submits the £10,000 payment idempotently and shows a real pending status", async ({ page }) => {
  const bankingApi = await mockPhaseABankingApi(page);
  await page.goto("/payments");

  await expect(page.getByRole("heading", { name: "Who are you paying?" })).toBeVisible();
  await page.getByRole("button", { name: /Sam Bennett/ }).click();
  await page.getByRole("button", { name: "Continue →" }).click();

  await expect(page.getByRole("heading", { name: "How much?" })).toBeVisible();
  await expect(page.getByLabel("Amount in pounds")).toHaveValue("10000");
  await page.getByRole("button", { name: "Review payment →" }).click();

  await expect(page.getByRole("heading", { name: "One last look" })).toBeVisible();
  await expect(page.getByText("£10,000.00", { exact: true })).toBeVisible();
  await expect(page.getByText(/submission creates an immutable payment attempt/)).toBeVisible();
  await page.getByRole("button", { name: "Submit fictional payment" }).click();

  await expect(page.getByRole("heading", { name: "We’re checking this payment" })).toBeVisible();
  await expect(page.getByText("PENDING · DETERMINISTIC POLICY", { exact: true })).toBeVisible();
  await expect(page.getByText(/No ledger entry was created/)).toBeVisible();
  await expect(page.getByText(/waiting for independent LightGBM evidence/)).toBeVisible();
  expect(bankingApi.paymentRequests).toHaveLength(1);
  expect(bankingApi.paymentRequests[0]).toMatchObject({
    body: {
      amount: "10000.00",
      beneficiaryId: "8e252606-f346-522c-a62e-bdd3aee2b45a",
      reference: "Property deposit",
    },
  });
  expect(bankingApi.paymentRequests[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(bankingApi.paymentRequests[0].origin).toBe(
    new URL(bankingApi.paymentRequests[0].url).origin,
  );
  for (const verdict of ["APPROVED", "CHALLENGED", "BLOCKED"]) {
    await expect(page.getByText(verdict, { exact: true })).toHaveCount(0);
  }
});

test("Pay beside a beneficiary opens the amount step with that recipient selected", async ({ page }) => {
  await mockPhaseABankingApi(page);
  await page.goto("/beneficiaries");

  await page
    .locator('a[href="/payments?beneficiary=8e252606-f346-522c-a62e-bdd3aee2b45a"]')
    .click();

  await expect(page).toHaveURL(/\/payments\?beneficiary=8e252606-f346-522c-a62e-bdd3aee2b45a/);
  await expect(page.getByRole("heading", { name: "How much?" })).toBeVisible();
  await expect(page.getByText(/Enter the amount and reference for/)).toContainText("Sam Bennett");
  await expect(page.getByRole("heading", { name: "Who are you paying?" })).toHaveCount(0);

  await page.getByRole("button", { name: "Change recipient" }).click();
  await expect(page).toHaveURL(/\/payments$/);
  await expect(page.getByRole("heading", { name: "Who are you paying?" })).toBeVisible();
});

test("has no detectable WCAG A or AA violations on the loaded overview", async ({ page }) => {
  await mockPhaseABankingApi(page);
  await page.goto("/");
  await expect(page.getByText("Whole Foods Market", { exact: true })).toBeVisible();

  // @axe-core/playwright permits a newer playwright-core minor than this app pins.
  // Its Page type is structurally compatible at runtime, but not assignable across those minors.
  const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"];
  const results = await new AxeBuilder({ page: axePage })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const violations = results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map((node) => node.target.join(" ")),
  }));
  expect(violations).toEqual([]);
});
