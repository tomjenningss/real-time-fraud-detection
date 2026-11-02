import { expect, test } from "@playwright/test";

const liveEnabled = process.env.RUN_GLARAMARA_PHASE_C_LIVE === "1";
const paymentId = process.env.GLARAMARA_PHASE_C_PAYMENT_ID?.trim() ?? "";

test.describe("Phase C live Orchestrate journey", () => {
  test.skip(!liveEnabled, "live Phase C journey is explicitly opt-in");
  test.setTimeout(120_000);

  test("uses the browser journey while preserving the original challenged verdict", async ({ page }) => {
    expect(paymentId).toMatch(/^[0-9a-f-]{36}$/i);
    await page.goto(`/payments/status?paymentId=${encodeURIComponent(paymentId)}`);

    await expect(page.getByText("CHALLENGED · DETERMINISTIC POLICY", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Start security check" }).click();
    await expect(page.getByRole("heading", { name: "A quick security check" })).toBeVisible();
    await page.getByRole("button", { name: /Start check/ }).click();

    for (const answer of ["Yes, I made it", "Someone I know", "Friends or family", "No"]) {
      await page.getByLabel(answer, { exact: true }).check();
      await page.getByRole("button", { name: "Save and continue" }).click();
    }
    const circumstances = page.getByRole("textbox");
    if (await circumstances.isVisible()) {
      await circumstances.fill(
        "An unfamiliar number said my daughter abroad needed urgent help and directed me to an unknown beneficiary.",
      );
      await page.getByRole("button", { name: "Save and continue" }).click();
    }
    await expect(page.getByRole("heading", { name: "Your answers are ready" })).toBeVisible();
    await page.getByRole("button", { name: "Analyse my answers" }).click();

    await expect(page.getByRole("heading", { name: "Security check cleared" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByText(/original CHALLENGED verdict is immutable/)).toBeVisible();
    await page.getByRole("link", { name: "View original decision" }).click();
    await expect(page.getByText("CHALLENGED · DETERMINISTIC POLICY", { exact: true })).toBeVisible();
    await expect(page.getByText(/No ledger entry was created/)).toBeVisible();
  });
});
