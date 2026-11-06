#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await readFile(
  path.join(HERE, "model-benchmark-independent-50/scenarios.json"), "utf8",
));
const ids = [
  "legitimate-builder-stage-payment",
  "investment-crypto-liquidity-release",
  "family-ai-voice-grandson-bail",
  "ambiguous-beneficiary-trading-name",
  "legitimate-high-value-kitchen",
  "ambiguous-remote-access-unsure",
];
const byId = new Map(source.scenarios.map((scenario) => [scenario.id, scenario]));
const scenarios = ids.map((id) => {
  const scenario = byId.get(id);
  if (!scenario) throw new Error(`Frozen scenario not found: ${id}`);
  return scenario;
});
const output = path.join(HERE, "results/gemma-promotion-20261106/acceptance-suite.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  suiteVersion: "glaramara-gemma-promotion-acceptance/1.0.0",
  sourceSuiteVersion: source.suiteVersion,
  sourceFrozenAt: source.frozenAt,
  scenarioCount: scenarios.length,
  scenarios,
}, null, 2)}\n`);
process.stdout.write(`Generated ${scenarios.length}-case frozen acceptance subset at ${output}\n`);
