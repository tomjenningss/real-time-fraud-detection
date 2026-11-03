import { expect, test } from "@playwright/test";

const paymentId = process.env.GLARAMARA_FRAUD_INTELLIGENCE_PAYMENT_ID;

test.describe("live persisted Fraud Intelligence view", () => {
  test.skip(!paymentId, "requires a completed owned payment from the isolated development stack");

  test("renders and replays real evidence without mutations", async ({ page }, testInfo) => {
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") mutations.push(`${request.method()} ${request.url()}`);
    });

    await page.goto(`/payments/status?paymentId=${encodeURIComponent(paymentId!)}`);
    await expect(page.getByRole("heading", { name: "Payment approved" })).toBeVisible();
    await page.getByRole("checkbox", { name: /System view/ }).check();
    await expect(page.getByRole("heading", { name: "System investigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Event-time enrichment: complete/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /LightGBM scorer: complete/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Shadow decision engine: complete/ })).toBeVisible();

    await page.getByRole("button", { name: /Replay investigation/ }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.locator(".system-flow-particle").first()).toBeVisible();
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await page.getByRole("button", { name: "Restart" }).click();

    await page.screenshot({
      path: testInfo.outputPath("live-fraud-intelligence.png"),
      fullPage: true,
    });
    expect(mutations).toEqual([]);
  });
});
