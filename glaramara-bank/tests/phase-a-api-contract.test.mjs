import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("Phase B banking API routes expose submission, owned status and health", () => {
  for (const route of [
    "app/api/v1/demo/session/route.ts",
    "app/api/v1/dashboard/route.ts",
    "app/api/v1/activity/route.ts",
    "app/api/v1/beneficiaries/route.ts",
    "app/api/v1/payments/route.ts",
    "app/api/v1/payments/[paymentId]/route.ts",
    "app/api/v1/health/route.ts",
  ]) {
    assert.equal(statSync(join(root, route)).isFile(), true, `${route} should exist`);
  }
});

test("demo sessions are signed and use hardened browser-cookie attributes", () => {
  const session = read("lib/server/session.ts");

  assert.match(session, /createHmac\("sha256"/);
  assert.match(session, /timingSafeEqual/);
  assert.match(session, /httpOnly:\s*true/);
  assert.match(session, /sameSite:\s*"lax"/);
  assert.match(session, /secure:\s*secureSessionCookie\(\)/);
  assert.match(session, /return process\.env\.NODE_ENV === "production"/);
  assert.match(session, /GLARAMARA_COOKIE_SECURE/);
  assert.match(session, /GLARAMARA_SESSION_SECRET/);
});

test("business routes derive customer identity from the signed session", () => {
  for (const route of [
    "app/api/v1/dashboard/route.ts",
    "app/api/v1/activity/route.ts",
    "app/api/v1/beneficiaries/route.ts",
    "app/api/v1/payments/route.ts",
    "app/api/v1/payments/[paymentId]/route.ts",
  ]) {
    const source = read(route);
    assert.match(source, /requireDemoSession\(request\)/);
    assert.match(source, /session\.customerId/);
    assert.doesNotMatch(source, /body\.customerId/);
  }
});

test("all browser mutations enforce same-origin requests", () => {
  for (const route of [
    "app/api/v1/demo/session/route.ts",
    "app/api/v1/beneficiaries/route.ts",
    "app/api/v1/payments/route.ts",
  ]) {
    const source = read(route);
    assert.match(source, /export async function POST/);
    assert.match(source, /requireSameOrigin\(request\)/);
  }
});

test("payment repository is transactional, idempotent and preserves authority boundaries", () => {
  const repository = read("lib/server/banking-repository.ts");

  assert.match(repository, /WHERE customer_id = \$1/);
  assert.match(repository, /ledgerMode:\s*"SIMULATED_NO_MOVEMENT"/);
  assert.match(repository, /withTransaction/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /banking_payment_attempts/);
  assert.match(repository, /outbox_events/);
  assert.match(repository, /banking_payment_raw/);
  assert.match(repository, /banking_payment_watermark/);
  assert.match(repository, /clock_timestamp\(\) \+ interval '3 seconds'/);
  assert.match(repository, /raw_event_time_clock/);
  assert.match(repository, /payments\.raw\.demo:event-time/);
  assert.match(repository, /payments\.raw\.demo/);
  assert.match(repository, /FROM banking_payment_status status/);
  assert.match(repository, /fraud-action-policy-v1/);
  assert.doesNotMatch(repository, /UPDATE\s+payment_decisions/i);
  assert.doesNotMatch(repository, /UPDATE\s+banking_accounts/i);
  assert.doesNotMatch(repository, /INSERT INTO banking_transactions/i);
});

test("payment submission requires idempotency and trusted signed-session ownership", () => {
  const route = read("app/api/v1/payments/route.ts");

  assert.match(route, /idempotency-key/);
  assert.match(route, /IDEMPOTENCY_KEY_REQUIRED/);
  assert.match(route, /requireSameOrigin\(request\)/);
  assert.match(route, /requireDemoSession\(request\)/);
  assert.match(route, /session\.customerId/);
  assert.match(route, /session\.demoLocationId/);
  assert.doesNotMatch(route, /body\.customerId/);
});
