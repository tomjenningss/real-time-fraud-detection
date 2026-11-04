import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("approved brand tokens and mountain geometry remain present", () => {
  const css = read("app/globals.css");
  const mountain = read("components/mountain-mark.tsx");

  for (const colour of ["#173f33", "#275a47", "#d6e9b8", "#f5f7f3"]) {
    assert.match(css.toLowerCase(), new RegExp(colour));
  }
  assert.match(mountain, /M4 30 15 12l8 12 5-7 9 13/);
  assert.match(mountain, /M3 86 38 23 64 66 80 44 128 96/);
  assert.match(mountain, /M3 96c28-13 46-13 71 0 18-12 35-11 54 1/);
  assert.match(mountain, /glaramara/);
});

test("all Phase A banking routes exist", () => {
  for (const route of [
    "app/page.tsx",
    "app/activity/page.tsx",
    "app/beneficiaries/page.tsx",
    "app/cards/page.tsx",
    "app/payments/page.tsx",
    "app/payments/status/page.tsx",
  ]) {
    assert.equal(statSync(join(root, route)).isFile(), true, `${route} should exist`);
  }
});

test("payment UI submits idempotently and contains no client-side verdict rules", () => {
  const payment = read("app/payments/page.tsx");
  const status = read("app/payments/status/payment-status-client.tsx");

  assert.match(payment, /Idempotency-Key/);
  assert.match(payment, /useSearchParams/);
  assert.match(payment, /requestedBeneficiaryId/);
  assert.match(payment, /Change recipient/);
  assert.match(payment, /Send payment/);
  assert.match(status, /payment\?\.status/);
  assert.match(status, /This payment has not been sent/);
  assert.match(status, /authoritativePending \|\| \(!shadowFinished && polls < 80\)/);
  assert.match(status, /polls < 80 \? 1_500 : 10_000/);
  assert.doesNotMatch(payment, /amount\s*>?=\s*(5000|10000|20000|25000)/);
  assert.doesNotMatch(status, /amount\s*>?=\s*(5000|10000|20000|25000)/);
});

test("navigation provides both desktop and mobile banking access", () => {
  const shell = read("components/banking-shell.tsx");

  for (const label of ["Overview", "Payments", "Activity", "Beneficiaries", "Cards"]) {
    assert.match(shell, new RegExp(label));
  }
  assert.match(shell, /Mobile navigation/);
  assert.match(shell, /Demo account/);
  assert.doesNotMatch(shell, /INTERACTIVE DEMO|Fictional demo account/);
});
