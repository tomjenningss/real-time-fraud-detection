#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContext, canonicalEvidence } from "./run_suite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(await readFile(path.join(HERE, "scenarios.json"), "utf8"));
const output = path.join(HERE, "native-cases");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const scenario of suite.scenarios) {
  const context = buildContext(scenario);
  const expected = canonicalEvidence(scenario);
  const testCase = {
    agent: "fraud_intelligence",
    goals: { summarize: [] },
    goal_details: [{
      type: "text",
      name: "summarize",
      response: JSON.stringify(expected),
      keywords: [
        "fraud-intelligence-evidence/1.1.0",
        expected.paymentRecognition,
        expected.paymentPurpose,
        expected.uncertainty,
        ...scenario.expectedEvidence.requiredIndicators,
      ],
    }],
    story: JSON.stringify(context),
    starting_sentence: JSON.stringify(context),
  };
  await writeFile(
    path.join(output, `${scenario.id}.json`),
    `${JSON.stringify(testCase, null, 2)}\n`,
  );
}

process.stdout.write(`Generated ${suite.scenarios.length} native cases in ${output}\n`);
