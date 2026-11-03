import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("Phase D exposes analyst-only dashboard, analysis, detail and review routes", () => {
  for (const route of [
    "app/api/v1/fraud-operations/route.ts",
    "app/api/v1/fraud-operations/analyses/route.ts",
    "app/api/v1/fraud-operations/runs/[runId]/route.ts",
    "app/api/v1/fraud-operations/candidates/[candidateId]/reviews/route.ts",
  ]) {
    assert.equal(statSync(join(root, route)).isFile(), true);
    assert.match(read(route), /requireAnalystSession\(request\)/);
  }
  assert.match(read("app/api/v1/fraud-operations/analyses/route.ts"), /requireSameOrigin\(request\)/);
  assert.match(read("app/api/v1/fraud-operations/candidates/[candidateId]/reviews/route.ts"), /requireSameOrigin\(request\)/);
});

test("analyst authority is server-derived and customer sessions stay compatible", () => {
  const session = read("lib/server/session.ts");
  const route = read("app/api/v1/demo/session/route.ts");
  assert.match(session, /role: z\.literal\("FRAUD_ANALYST"\)/);
  assert.match(session, /analystId: z\.literal\("fraud-analyst-alex-morgan"\)/);
  assert.match(session, /legacyClaimsSchema/);
  assert.match(route, /input\.customerId === ANALYST_PERSONA\.id/);
  assert.doesNotMatch(route, /body\.role/);
});

test("rule discovery validates constrained proposals before loading evaluation rows", () => {
  const contracts = read("lib/fraud-rule-discovery/contracts.ts");
  const repository = read("lib/server/fraud-operations-repository.ts");
  assert.match(contracts, /fraud-rule-proposal\/1\.0\.0/);
  assert.match(contracts, /z\.literal\("ALL"\)/);
  assert.match(contracts, /z\.literal\("CHALLENGED"\)/);
  assert.match(contracts, /validateEvidenceReferences/);
  assert.match(repository, /partition = 'DISCOVERY'/);
  assert.match(repository, /proposal is durable/);
  assert.match(repository, /partition = 'EVALUATION'/);
  assert.ok(repository.indexOf("INSERT INTO fraud_rule_candidates") < repository.indexOf("partition = 'EVALUATION'"));
  assert.doesNotMatch(repository, /UPDATE\s+payment_decisions/i);
  assert.doesNotMatch(repository, /UPDATE\s+banking_accounts/i);
  assert.match(repository, /activeDeterministicControls/);
  assert.match(repository, /deploymentStatus: "NOT_DEPLOYED"/);
  assert.match(repository, /APPROVED_FOR_IMPLEMENTATION means pending engineering implementation only/);
});

test("backtest recomputes chronological state and reports incremental effects", () => {
  const evaluator = read("lib/fraud-rule-discovery/evaluator.ts");
  assert.match(evaluator, /customerHistory/);
  assert.match(evaluator, /beneficiaryHistory/);
  assert.match(evaluator, /customerBeneficiaryCounts/);
  assert.match(evaluator, /additionalFraudDetected/);
  assert.match(evaluator, /additionalLegitimateChallenged/);
  assert.match(evaluator, /does not emulate Flink watermarks/);
});

test("Fraud Rule Discovery REST credentials remain server-only", () => {
  const client = read("lib/fraud-rule-discovery/orchestrate-client.ts");
  assert.match(client, /WATSONX_ORCHESTRATE_URL/);
  assert.match(client, /IbmIamTokenProvider/);
  assert.match(client, /FRAUD_RULE_DISCOVERY_AGENT_ID/);
  assert.match(client, /fraudRuleProposalSchema\.parse/);
  assert.match(client, /FraudRuleDiscoveryProposalNotFoundError/);
  assert.match(client, /FraudRuleDiscoveryInvalidProposalError/);
  assert.doesNotMatch(client, /NEXT_PUBLIC_/);
  assert.doesNotMatch(client, /node:child_process|\bspawn\s*\(/);
});

test("Fraud Operations distinguishes current data from historical snapshots", () => {
  const dashboard = read("app/fraud-operations/fraud-operations-client.tsx");
  assert.match(dashboard, /Current active dataset/);
  assert.match(dashboard, /Historical analysis snapshot/);
  assert.match(dashboard, /Historical snapshot:/);
});
