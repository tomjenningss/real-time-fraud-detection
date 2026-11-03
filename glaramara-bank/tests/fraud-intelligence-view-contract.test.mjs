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

test("diagram includes real authority boundaries, animated branches and replay controls", () => {
  const panelPath = "components/fraud-intelligence/fraud-intelligence-panel.tsx";
  assert.equal(statSync(join(root, panelPath)).isFile(), true);
  const panel = read(panelPath);

  for (const stage of [
    "postgres_outbox",
    "kafka",
    "flink_enrichment",
    "authoritative_policy",
    "lightgbm_shadow",
    "go_correlation",
    "go_shadow_policy",
    "fraud_intelligence_provider",
    "governed_reassessment",
  ]) assert.match(panel, new RegExp(stage));
  assert.match(panel, /animateMotion/);
  assert.match(panel, /parallel branches/);
  assert.match(panel, /Pause/);
  assert.match(panel, /Resume/);
  assert.match(panel, /Restart/);
  assert.match(panel, /value=\{4\}/);
  assert.match(panel, /Structured JSON/);
});

test("system view client only reads the projection endpoint", () => {
  const panel = read("components/fraud-intelligence/fraud-intelligence-panel.tsx");
  assert.match(panel, /fraud-intelligence/);
  assert.doesNotMatch(panel, /method:\s*["']POST/);
  assert.doesNotMatch(panel, /\/extract/);
  assert.doesNotMatch(panel, /setTimeout\([^,]+,\s*(?:500|1000)\)/);
});
