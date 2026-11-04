import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("system view is session-scoped and shared across the payment journey", () => {
  const provider = read("components/fraud-intelligence/system-view-provider.tsx");
  const shell = read("components/banking-shell.tsx");
  const status = read("app/payments/status/page.tsx");
  const investigation = read("app/payments/investigation/page.tsx");

  assert.match(provider, /sessionStorage/);
  assert.doesNotMatch(provider, /localStorage/);
  assert.match(shell, /SYSTEM VIEW/);
  assert.match(status, /SystemViewJourney/);
  assert.match(investigation, /SystemViewJourney/);
});

test("system view augments the customer journey with a collapsible evidence breakdown", () => {
  const breakdownPath = "components/fraud-intelligence/fraud-decision-breakdown.tsx";
  assert.equal(statSync(join(root, breakdownPath)).isFile(), true);
  const breakdown = read(breakdownPath);
  const journey = read("components/fraud-intelligence/system-view-journey.tsx");

  for (const stage of [
    "flink_enrichment",
    "authoritative_policy",
    "lightgbm_shadow",
    "go_correlation",
    "fraud_intelligence_provider",
    "governed_reassessment",
    "simulated_outcome",
  ]) assert.match(breakdown, new RegExp(stage));
  for (const label of [
    "Fraud decision breakdown",
    "Apache Flink",
    "Deterministic router",
    "LightGBM",
    "Go correlator",
    "watsonx Orchestrate",
    "Payment outcome",
    "SHADOW ONLY",
  ]) assert.match(breakdown, new RegExp(label));
  assert.match(breakdown, /<details/);
  assert.match(journey, /\{children\}[\s\S]*<FraudDecisionBreakdown/);
  assert.match(journey, /Architecture flow/);
  assert.match(journey, /<FraudIntelligencePanel/);
});

test("system view client only reads the projection endpoint", () => {
  const breakdown = read("components/fraud-intelligence/fraud-decision-breakdown.tsx");
  assert.match(breakdown, /fraud-intelligence/);
  assert.doesNotMatch(breakdown, /method:\s*["']POST/);
  assert.doesNotMatch(breakdown, /\/extract/);
});
