#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "model-benchmark-independent-50");
const RESULTS = path.join(HERE, "results/native-modified-20261106/campaign");
const suite = JSON.parse(await readFile(path.join(SOURCE, "scenarios.json"), "utf8"));
const scenarios = new Map(suite.scenarios.map((item) => [item.id, item]));
const included = JSON.parse(await readFile(
  path.join(HERE, "native-modified-input-20261106/groq/conversion-manifest.json"), "utf8",
)).cases.map(({ scenarioId }) => scenarioId);
const topKeys = ["beneficiaryRelationship", "clarificationQuestion", "contradictions", "missingEvidence",
  "paymentPurpose", "paymentRecognition", "provenance", "scamIndicators", "schemaVersion",
  "thirdPartyInfluence", "uncertainty", "verificationClaims"];

function same(a, b) { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
}
function schemaValid(evidence) {
  return evidence?.schemaVersion === "fraud-intelligence-evidence/1.1.0"
    && same(Object.keys(evidence), topKeys)
    && ["verificationClaims", "scamIndicators", "contradictions", "missingEvidence", "provenance"]
      .every((key) => Array.isArray(evidence[key]));
}
function grade(scenario, evidence) {
  if (!schemaValid(evidence)) return { exact: false, schemaValid: false, differences: ["schema"] };
  const expected = scenario.expectedEvidence;
  const answers = scenario.answers;
  const factPreserved = ["paymentRecognition", "beneficiaryRelationship", "paymentPurpose",
    "thirdPartyInfluence"].every((key) => evidence[key] === expected[key]);
  const indicators = same(evidence.scamIndicators, expected.requiredIndicators);
  const claims = same(evidence.verificationClaims, expected.verificationClaims);
  const contradiction = evidence.contradictions.length >= expected.minimumContradictions;
  const uncertainty = evidence.uncertainty === expected.uncertainty;
  const ids = new Set(evidence.provenance.map((item) => item?.findingId));
  const provenance = expected.requiredProvenance.every((id) => ids.has(id))
    && evidence.provenance.every((item) => Array.isArray(item?.sources) && item.sources.length
      && item.sources.every((source) => typeof answers[source.questionId] === "string"
        && answers[source.questionId].includes(source.excerpt)));
  const checks = { factPreserved, indicators, claims, contradiction, uncertainty, provenance };
  return { exact: Object.values(checks).every(Boolean), schemaValid: true,
    differences: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key) };
}
async function latestRun(model) {
  const root = path.join(RESULTS, model);
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return path.join(root, directories.at(-1));
}
async function historical(model) {
  const summary = JSON.parse(await readFile(path.join(SOURCE, `${model}-strict-summary.json`), "utf8"));
  return new Map(summary.scenarios.map((item) => [item.id, item.extraction.status === "PASS"]));
}
async function summarize(model, identifier) {
  const runDir = await latestRun(model);
  const rows = [];
  for (const id of included) {
    const base = path.join(runDir, "messages/glaramara-modified-input-native-subset/1.0.0", id);
    const messages = JSON.parse(await readFile(`${base}.messages.json`, "utf8"));
    const metrics = JSON.parse((await readFile(`${base}.metrics.json`, "utf8")).replaceAll("NaN", "null"));
    const assistant = messages.findLast(({ role }) => role === "assistant");
    let evidence = null;
    let parseError = null;
    try {
      const match = assistant?.content.match(/\{[\s\S]*\}/);
      evidence = match ? JSON.parse(match[0]) : null;
    } catch (error) { parseError = error.message; }
    const result = grade(scenarios.get(id), evidence);
    rows.push({ scenarioId: id, ...result, parseError, latencySeconds: assistant?.response_time ?? null,
      totalSteps: metrics.total_steps, llmSteps: metrics.llm_steps, nativeKeywordMatch: metrics.keyword_match,
      nativeSemanticMatch: metrics.semantic_match, nativeTextMatch: metrics.text_match,
      nativeJourneySuccess: metrics.is_success });
  }
  const latencies = rows.map(({ latencySeconds }) => latencySeconds).filter(Number.isFinite);
  const output = { model, modelIdentifier: identifier, runDirectory: path.relative(HERE, runDir),
    scenarioCount: rows.length, successfulInvocations: rows.filter(({ llmSteps }) => llmSteps > 0).length,
    schemaValid: rows.filter((row) => row.schemaValid).length,
    independentStrict: { pass: rows.filter((row) => row.exact).length, total: rows.length },
    native: {
      journeySuccess: rows.filter(({ nativeJourneySuccess }) => nativeJourneySuccess).length,
      keywordMatch: rows.filter(({ nativeKeywordMatch }) => nativeKeywordMatch).length,
      semanticMatch: rows.filter(({ nativeSemanticMatch }) => nativeSemanticMatch).length,
      textMatch: rows.filter(({ nativeTextMatch }) => nativeTextMatch).length,
      totalSteps: rows.reduce((sum, row) => sum + (row.totalSteps ?? 0), 0),
      llmSteps: rows.reduce((sum, row) => sum + (row.llmSteps ?? 0), 0),
    },
    latencySeconds: { mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }, rows };
  if (model !== "frontier") {
    const previous = await historical(model);
    let agreements = 0;
    for (const row of rows) if (row.exact === previous.get(row.scenarioId)) agreements += 1;
    output.historicalIndependent = {
      pass: included.filter((id) => previous.get(id)).length,
      total: included.length,
      nativeAgreement: agreements,
      nativeDisagreement: included.length - agreements,
    };
  }
  return output;
}

const report = {
  schemaVersion: "glaramara-modified-native-comparison/1.0.0",
  generatedAt: new Date().toISOString(),
  label: "modified-input native evaluation subset; not a direct reproduction of the frozen 50-case benchmark",
  includedScenarioCount: included.length,
  models: {
    groq: await summarize("groq", "groq/openai/gpt-oss-120b"),
    gemma: await summarize("gemma", "bedrock-mantle/google.gemma-4-31b"),
    frontier: await summarize("frontier", "watsonx-orchestrate/frontier (observed alias to bedrock/us.anthropic.claude-sonnet-4-6)"),
  },
};
await writeFile(path.join(RESULTS, "comparison-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
