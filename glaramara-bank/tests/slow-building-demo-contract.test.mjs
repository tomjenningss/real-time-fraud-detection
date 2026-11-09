import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repository = readFileSync("lib/server/slow-building-demo-repository.ts", "utf8");
const route = readFileSync("app/api/v1/fraud-operations/slow-building-demo/route.ts", "utf8");
const client = readFileSync(
  "app/fraud-operations/slow-building-demo/slow-building-demo-client.tsx",
  "utf8",
);

test("slow-building replay is analyst-only, same-origin and isolated from live topics", () => {
  assert.match(route, /requireAnalystSession\(request\)/);
  assert.match(route, /requireSameOrigin\(request\)/);
  assert.match(repository, /payments\.raw\.slow-building-replay/);
  assert.match(repository, /payments\.enriched\.slow-building-replay/);
  assert.doesNotMatch(repository, /["']payments\.raw\.demo["']/);
  assert.doesNotMatch(repository, /["']payments\.enriched\.demo["']/);
});

test("replay uses the outbox, five event-time payments and no ledger mutation", () => {
  assert.match(repository, /AMOUNTS = \[200, 400, 750, 1_500, 3_000\]/);
  assert.match(repository, /INSERT INTO outbox_events/);
  assert.match(repository, /beneficiary_id: selected\.beneficiary_id/);
  assert.match(repository, /ledgerEffect: "NONE"/);
  assert.doesNotMatch(repository, /INSERT INTO banking_transactions/);
  assert.doesNotMatch(repository, /UPDATE banking_accounts/);
  assert.doesNotMatch(repository, /INSERT INTO payment_decisions/);
});

test("developer UI renders persisted features and policy results without computing a verdict", () => {
  assert.match(client, /Replay slow-building investment scam/);
  assert.match(client, /payment\.features\.cumulative_amount_30d/);
  assert.match(client, /payment\.baseline\.policyVersion/);
  assert.match(client, /payment\.demo\.verdict/);
  assert.doesNotMatch(client, /setVerdict|decide\(|amount\s*[><=]+\s*3000/);
});

test("completed replay hands off through the signed customer session before payment status", () => {
  assert.match(client, /bankingFetch\("\/api\/v1\/demo\/session"/);
  assert.match(client, /customerId: replay\.customer\.id/);
  assert.match(client, /payments\/status\?paymentId=/);
  assert.match(client, /Continue as \{run\.customer\.name\}/);
});
