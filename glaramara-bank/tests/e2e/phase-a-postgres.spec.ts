import { expect, test } from "@playwright/test";

const postgresEnabled = process.env.RUN_GLARAMARA_POSTGRES_TESTS === "1";

test.describe("Phase B PostgreSQL API", () => {
  test.skip(!postgresEnabled, "requires an explicitly approved isolated PostgreSQL database");

  test("serves seeded records and accepts an idempotent fictional payment", async ({
    context,
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("£24,862.80", { exact: true })).toBeVisible();
    await expect(page.getByText("Whole Foods Market", { exact: true })).toBeVisible();

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === "glaramara_demo_session");
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    const dashboard = await page.request.get("/api/v1/dashboard");
    expect(dashboard.status()).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      customer: { slug: "alex-morgan", fictional: true },
      account: {
        accountNumber: "00007281",
        availableBalance: 24862.8,
        ledgerMode: "SIMULATED_NO_MOVEMENT",
      },
    });

    const missingOrigin = await page.request.post("/api/v1/beneficiaries", {
      data: { displayName: "Missing Origin", sortCode: "20-44-83", accountNumber: "00112233" },
    });
    expect(missingOrigin.status()).toBe(403);

    const accountNumber = "00218459";
    const created = await page.evaluate(async (number) => {
      const response = await fetch("/api/v1/beneficiaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Lakeview Property Ltd",
          sortCode: "20-44-83",
          accountNumber: number,
        }),
      });
      return { body: await response.json(), status: response.status };
    }, accountNumber);
    expect(created.status, JSON.stringify(created)).toBe(201);
    expect(created.body).toMatchObject({
      beneficiary: {
        name: "Lakeview Property Ltd",
        accountNumber,
        recent: false,
      },
    });

    const listed = await page.request.get("/api/v1/beneficiaries");
    const listedBody = await listed.json();
    expect(listed.status()).toBe(200);
    expect(listedBody.beneficiaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Lakeview Property Ltd", accountNumber }),
      ]),
    );

    const payment = await page.evaluate(async () => {
      const key = crypto.randomUUID();
      const body = {
        beneficiaryId: "1f8a727f-40f8-5b81-b3d7-a52033395fc6",
        amount: "123.45",
        reference: "Phase B test",
      };
      const submit = (value: typeof body) => fetch("/api/v1/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(value),
      });
      const first = await submit(body);
      const firstBody = await first.json();
      const replay = await submit(body);
      const replayBody = await replay.json();
      const conflict = await submit({ ...body, amount: "124.45" });
      const status = await fetch(`/api/v1/payments/${firstBody.payment.id}`);
      return {
        firstStatus: first.status,
        firstBody,
        replayStatus: replay.status,
        replayBody,
        conflictStatus: conflict.status,
        conflictBody: await conflict.json(),
        statusCode: status.status,
        statusBody: await status.json(),
      };
    });
    expect(payment.firstStatus, JSON.stringify(payment)).toBe(202);
    expect(payment.firstBody).toMatchObject({
      replayed: false,
      payment: {
        amount: 123.45,
        status: "PENDING",
        simulated: true,
        ledgerEffect: "NONE",
        processing: { publicationStatus: "PENDING" },
      },
    });
    expect(payment.replayStatus).toBe(200);
    expect(payment.replayBody).toMatchObject({
      replayed: true,
      payment: { id: payment.firstBody.payment.id },
    });
    expect(payment.conflictStatus).toBe(409);
    expect(payment.conflictBody).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(payment.statusCode).toBe(200);
    expect(payment.statusBody).toMatchObject({ payment: { id: payment.firstBody.payment.id } });
  });
});
