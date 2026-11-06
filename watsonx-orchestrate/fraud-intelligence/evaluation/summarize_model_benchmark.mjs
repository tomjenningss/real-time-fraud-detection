#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFraudPreventionGuidance } from "../../../glaramara-bank/lib/fraud-intelligence/guidance.mjs";
import { reassessFraudEvidence } from "../../../glaramara-bank/lib/fraud-intelligence/policy.mjs";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("usage: summarize_model_benchmark.mjs ROOT OUTPUT");

const variants = {
  frontier: "watsonx-orchestrate/frontier",
  groq: "groq/openai/gpt-oss-120b",
  claude: "bedrock/us.anthropic.claude-sonnet-4-6",
  "bedrock-oss": "bedrock/openai.gpt-oss-120b-1:0",
  gemma: "bedrock-mantle/google.gemma-4-31b",
  "watsonx-oss": "watsonx/openai/gpt-oss-120b",
  llama33: "watsonx/meta-llama/llama-3-3-70b-instruct",
  llama4: "watsonx/meta-llama/llama-4-maverick-17b-128e-instruct-fp8",
  "mistral-large": "watsonx/mistral-large-2512",
  "mistral-small": "watsonx/mistralai/mistral-small-3-1-24b-instruct-2503",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const originalSuite = JSON.parse(await readFile(path.join(here, "scenarios.json"), "utf8"));
const heldoutSuite = JSON.parse(await readFile(path.join(here, "unseen-scenarios.json"), "utf8"));

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function guidanceMatches(scenario, evidence, policy) {
  const guidance = buildFraudPreventionGuidance({
    evidence,
    reassessment: policy,
    customerExplanation: scenario.answers.payment_circumstances ?? null,
    context: {
      amount: scenario.payment?.amount ?? 5_000,
      currency: "GBP",
      beneficiaryPreviouslyPaid: scenario.payment?.beneficiaryPreviouslyPaid ?? false,
    },
  });
  const rendered = [
    guidance.rendered.heading, guidance.rendered.context, ...guidance.rendered.steps,
    guidance.rendered.paymentStatus, guidance.rendered.simulationNotice,
  ].join("\n").toLowerCase();
  return guidance.category === scenario.expectedGuidance.category
    && scenario.expectedGuidance.requiredText.every((text) => rendered.includes(text.toLowerCase()))
    && scenario.expectedGuidance.forbiddenText.every((text) => !rendered.includes(text.toLowerCase()));
}

async function evaluatePartition(slug, partition, suite) {
  const directory = path.join(root, slug, partition);
  let entries = [];
  try { entries = await readdir(directory); } catch { return null; }
  const records = [];
  for (const entry of entries.filter((name) => name.endsWith(".json") && name !== "manifest.json")) {
    records.push(JSON.parse(await readFile(path.join(directory, entry), "utf8")));
  }
  const scenarios = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));
  let tp = 0; let fp = 0; let fn = 0; let policyPass = 0; let guidancePass = 0;
  let evidenceCount = 0;
  const latencies = [];
  for (const record of records) {
    if (Number.isFinite(record.latencyMs)) latencies.push(record.latencyMs);
    if (!record.evidence) continue;
    evidenceCount += 1;
    const scenario = scenarios.get(record.scenarioId);
    const expected = new Set(scenario.expectedEvidence.requiredIndicators.filter((value) => value !== "NONE"));
    const actual = new Set(record.evidence.scamIndicators.filter((value) => value !== "NONE"));
    for (const indicator of actual) expected.has(indicator) ? tp += 1 : fp += 1;
    for (const indicator of expected) if (!actual.has(indicator)) fn += 1;
    try {
      const policy = reassessFraudEvidence(record.evidence);
      if (policy.outcome === scenario.expectedPolicy.outcome
          && policy.policyTrace?.[0]?.ruleId === scenario.expectedPolicy.ruleId) policyPass += 1;
      if (guidanceMatches(scenario, record.evidence, policy)) guidancePass += 1;
    } catch { /* Count invalid downstream evidence as a failure. */ }
  }
  const summary = JSON.parse(await readFile(path.join(root, slug, `${partition}-summary.json`), "utf8"));
  const repeated = summary.scenarios.filter((item) => item.extraction.consistency);
  return {
    plannedInvocations: records.length,
    schemaValidResponses: evidenceCount,
    schemaValidRate: records.length ? evidenceCount / records.length : 0,
    exactScenarioPass: summary.execution.extraction.pass,
    exactScenarioTotal: summary.scenarioCount,
    exactInvocationPass: summary.execution.extraction.transportRuns.pass,
    exactInvocationTotal: summary.execution.extraction.transportRuns.pass
      + summary.execution.extraction.transportRuns.fail,
    indicator: {
      truePositives: tp, falsePositives: fp, falseNegatives: fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
    },
    reassessmentPass: policyPass,
    reassessmentTotal: records.length,
    guidancePass,
    guidanceTotal: records.length,
    latencyMs: {
      mean: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    errors: records.length - evidenceCount,
    repeatConsistency: {
      scenarios: repeated.length,
      exact: repeated.filter((item) => item.extraction.consistency.exact).length,
      semantic: repeated.filter((item) => item.extraction.consistency.semantic).length,
    },
  };
}

const report = { generatedAt: new Date().toISOString(), models: {} };
for (const [slug, model] of Object.entries(variants)) {
  report.models[slug] = {
    model,
    original: await evaluatePartition(slug, "original", originalSuite),
    heldout: await evaluatePartition(slug, "heldout", heldoutSuite),
  };
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
