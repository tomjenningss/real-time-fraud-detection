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
  const analysisRoute = read("app/api/v1/fraud-operations/analyses/route.ts");
  assert.match(analysisRoute, /requireSameOrigin\(request\)/);
  assert.match(analysisRoute, /FraudRuleDiscoveryDiagnosticError/);
  assert.match(analysisRoute, /FRAUD_LAB_INVALID_PROPOSAL/);
  assert.match(analysisRoute, /banking service remains available/);
  assert.match(read("app/api/v1/fraud-operations/candidates/[candidateId]/reviews/route.ts"), /requireSameOrigin\(request\)/);
});

test("Fraud Lab dataset operations are analyst-only, bounded and explicitly activated", () => {
  for (const route of [
    "app/api/v1/fraud-operations/datasets/route.ts",
    "app/api/v1/fraud-operations/datasets/[datasetId]/route.ts",
    "app/api/v1/fraud-operations/datasets/[datasetId]/activate/route.ts",
  ]) {
    assert.equal(statSync(join(root, route)).isFile(), true);
    assert.match(read(route), /requireAnalystSession\(request\)/);
  }
  const repository = read("lib/server/fraud-operations-repository.ts");
  const worker = read("../agents/src/fraud_agents/fraud_lab/dataset_worker.py");
  assert.match(repository, /z\.union\(\[z\.literal\(8_000\), z\.literal\(10_000\), z\.literal\(20_000\)\]\)/);
  assert.match(repository, /confirmation: z\.literal\("ACTIVATE"\)/);
  assert.match(repository, /FRAUD_LAB_GENERATION_IN_PROGRESS/);
  assert.match(repository, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(repository, /requested_by = \$1 AND idempotency_key = \$2/);
  assert.match(repository, /JOIN fraud_lab_dataset_waves member/);
  assert.doesNotMatch(worker, /subprocess|os\.system|eval\(|exec\(/);
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

test("malformed discovery proposals retain bounded, redacted analyst diagnostics without bypassing validation", () => {
  const client = read("lib/fraud-rule-discovery/orchestrate-client.ts");
  const repository = read("lib/server/fraud-operations-repository.ts");
  const migration = read("../agents/migrations/versions/0020_fraud_discovery_diagnostics.py");
  assert.match(client, /FraudRuleDiscoveryDiagnosticError/);
  assert.match(client, /validationIssues\(parsed\.error\)/);
  assert.match(client, /supportingEvidenceRefsState\(value\)/);
  assert.match(client, /MAX_DIAGNOSTIC_COMPLETION_BYTES/);
  assert.match(client, /\[REDACTED\]/);
  assert.doesNotMatch(client, /console\.(log|error)/);
  assert.match(repository, /persistDiscoveryDiagnostic/);
  assert.match(repository, /validationStage: "SEMANTIC"/);
  assert.match(repository, /FraudRuleDiscoveryEvidenceReferenceError/);
  assert.match(migration, /raw_completion jsonb/);
  assert.match(migration, /validation_issues jsonb NOT NULL/);
  assert.match(migration, /supporting_evidence_refs_state/);
  assert.match(migration, /validation_stage IN \('INVOCATION', 'STRUCTURAL', 'SEMANTIC'\)/);
});

test("Fraud Operations distinguishes current data from historical snapshots", () => {
  const dashboard = read("app/fraud-operations/fraud-operations-client.tsx");
  assert.match(dashboard, /Current active dataset/);
  assert.match(dashboard, /Immutable investigation/);
  assert.match(dashboard, /Historical snapshot:/);
});

test("Fraud Operations presents a sourced five-stage investigation narrative", () => {
  const dashboard = read("app/fraud-operations/fraud-operations-client.tsx");
  for (const stage of ["Emerging pattern", "Detection gap", "Proposed rule", "Independent backtest", "Human analyst decision"]) {
    assert.match(dashboard, new RegExp(stage));
  }
  assert.match(dashboard, /GLARAMARA OBSERVATION/);
  assert.match(dashboard, /GENERATED BY WATSONX ORCHESTRATE/);
  assert.match(dashboard, /CALCULATED DETERMINISTICALLY BY GLARAMARA/);
  assert.match(dashboard, /dashboard\.runs\.find\(\(item\) => item\.status === "COMPLETED"/);
  assert.match(dashboard, /additionalFraudDetected/);
  assert.match(dashboard, /additionalLegitimateChallenged/);
  assert.match(dashboard, /Technical evidence and provenance/);
  assert.match(dashboard, /Fraud recall comparison/);
  assert.match(dashboard, /Fraud detection versus customer friction/);
  assert.match(dashboard, /combined - baseline/);
  assert.match(dashboard, /additionalFraudDetected/);
  assert.match(dashboard, /additionalLegitimateChallenged/);
  assert.match(dashboard, /percentage of fraud detected/);
  assert.match(dashboard, /synthetic evaluation/);
  assert.match(dashboard, /operatorLabel/);
  assert.match(dashboard, /Orchestrate interpreted the discovery evidence; it did not independently verify/);
});

test("Fraud Operations System View derives a non-deployed Flink specification from the proposal", () => {
  const dashboard = read("app/fraud-operations/fraud-operations-client.tsx");
  const repository = read("lib/server/fraud-operations-repository.ts");
  assert.match(dashboard, /useSystemView/);
  assert.match(dashboard, /Raw proposal and evidence references/);
  assert.match(dashboard, /Proposed Flink implementation/);
  assert.match(dashboard, /PROPOSED — NOT DEPLOYED/);
  assert.match(dashboard, /proposal\.conditions\.map/);
  assert.match(dashboard, /payments\.raw\.demo/);
  assert.match(dashboard, /payments\.enriched\.demo/);
  assert.match(dashboard, /fraud\.signals\.demo/);
  assert.match(repository, /run\.discovery_report/);
});
