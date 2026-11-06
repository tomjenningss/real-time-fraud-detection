#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "model-benchmark-independent-50");
const DEFAULT_OUTPUT = path.join(HERE, "native-independent-50");

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    ids: [],
    excludeSubstrings: [],
    removeQuestionOptions: [],
    excludeSelectedPaymentPurposes: [],
    agent: "fraud_intelligence",
    caseDirectory: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") options.output = path.resolve(argv[++index]);
    else if (argv[index] === "--id") options.ids.push(argv[++index]);
    else if (argv[index] === "--exclude-substring") options.excludeSubstrings.push(argv[++index]);
    else if (argv[index] === "--remove-question-option") options.removeQuestionOptions.push(argv[++index]);
    else if (argv[index] === "--exclude-selected-payment-purpose") {
      options.excludeSelectedPaymentPurposes.push(argv[++index]);
    } else if (argv[index] === "--agent") options.agent = argv[++index];
    else if (argv[index] === "--case-directory") options.caseDirectory = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertNativeCase(testCase, scenarioId, expectedAgent) {
  if (testCase.agent !== expectedAgent) throw new Error(`${scenarioId}: invalid agent`);
  if (!testCase.story || testCase.story !== testCase.starting_sentence) {
    throw new Error(`${scenarioId}: story and starting_sentence must contain the same request`);
  }
  const request = JSON.parse(testCase.story);
  if (request.schemaVersion !== "fraud-intelligence-request/1.0.0") {
    throw new Error(`${scenarioId}: request schema version was not preserved`);
  }
  if (testCase.goal_details?.length !== 1 || testCase.goal_details[0].type !== "text") {
    throw new Error(`${scenarioId}: exactly one text goal is required`);
  }
  JSON.parse(testCase.goal_details[0].response);
}

const options = parseArgs(process.argv.slice(2));
const [scenarioText, groundTruthText, frozenText] = await Promise.all([
  readFile(path.join(SOURCE, "scenarios.json"), "utf8"),
  readFile(path.join(SOURCE, "ground-truth.json"), "utf8"),
  readFile(path.join(SOURCE, "frozen-manifest.json"), "utf8"),
]);
const suite = JSON.parse(scenarioText);
const groundTruth = JSON.parse(groundTruthText);
const frozen = JSON.parse(frozenText);

for (const [name, content] of [["scenarios.json", scenarioText], ["ground-truth.json", groundTruthText]]) {
  if (sha256(content) !== frozen.hashes[name]) throw new Error(`${name} does not match frozen-manifest.json`);
}
if (suite.scenarios.length !== frozen.scenarioCount || groundTruth.scenarios.length !== frozen.scenarioCount) {
  throw new Error("Frozen scenario count does not match source datasets");
}

const selectedIds = new Set(options.ids);
const selected = options.ids.length
  ? suite.scenarios.filter(({ id }) => selectedIds.has(id))
  : suite.scenarios;
if (selected.length !== (options.ids.length || suite.scenarios.length)) {
  const found = new Set(selected.map(({ id }) => id));
  throw new Error(`Unknown scenario id(s): ${options.ids.filter((id) => !found.has(id)).join(", ")}`);
}

const truths = new Map(groundTruth.scenarios.map((item) => [item.id, item]));
await rm(options.output, { recursive: true, force: true });
await mkdir(options.output, { recursive: true });
const caseOutput = options.caseDirectory
  ? path.join(options.output, options.caseDirectory)
  : options.output;
await mkdir(caseOutput, { recursive: true });
const cases = [];
const excludedCases = [];

for (const scenario of selected) {
  const requestText = await readFile(path.join(SOURCE, "requests", `${scenario.id}.json`), "utf8");
  const request = JSON.parse(requestText);
  const truth = truths.get(scenario.id);
  if (!truth) throw new Error(`${scenario.id}: missing frozen ground truth`);
  if (options.excludeSelectedPaymentPurposes.includes(scenario.answers.payment_purpose)) {
    excludedCases.push({
      scenarioId: scenario.id,
      category: scenario.category,
      reason: "selected payment_purpose is intentionally excluded from the modified-input campaign",
      selectedPaymentPurpose: scenario.answers.payment_purpose,
    });
    continue;
  }
  const removedQuestionOptions = [];
  for (const question of request.questions) {
    if (!question.options) continue;
    const originalOptions = [...question.options];
    question.options = question.options.filter((option) => !options.removeQuestionOptions.includes(option));
    for (const option of originalOptions.filter((option) => !question.options.includes(option))) {
      removedQuestionOptions.push({ questionId: question.id, option });
    }
  }
  const response = JSON.stringify(truth.canonicalEvidence);
  const testCase = {
    dataset_name: options.removeQuestionOptions.length
      ? `glaramara-modified-input-native-subset/1.0.0/${scenario.id}`
      : `glaramara-independent-50/1.0.0/${scenario.id}`,
    agent: options.agent,
    goals: { summarize: [] },
    goal_details: [{
      type: "text",
      name: "summarize",
      response,
      keywords: [
        "fraud-intelligence-evidence/1.1.0",
        truth.canonicalEvidence.paymentRecognition,
        truth.canonicalEvidence.paymentPurpose,
        truth.canonicalEvidence.uncertainty,
        ...truth.canonicalEvidence.scamIndicators,
      ],
    }],
    story: JSON.stringify(request),
    starting_sentence: JSON.stringify(request),
    max_user_turns: 1,
  };
  assertNativeCase(testCase, scenario.id, options.agent);
  const serializedCase = `${JSON.stringify(testCase, null, 2)}\n`;
  const matchedSubstrings = options.excludeSubstrings.filter((item) => serializedCase.includes(item));
  if (matchedSubstrings.length) {
    excludedCases.push({
      scenarioId: scenario.id,
      category: scenario.category,
      reason: "complete native evaluation input contains a termination-triggering substring",
      matchedSubstrings,
      selectedPaymentPurpose: scenario.answers.payment_purpose,
      selectedAnswerContainsMatch: matchedSubstrings.some(
        (item) => scenario.answers.payment_purpose.includes(item),
      ),
      questionnaireOptionsContainMatch: matchedSubstrings.some((item) =>
        request.questions.some(({ options = [] }) => options.some((option) => option.includes(item)))),
      occurrenceCounts: Object.fromEntries(matchedSubstrings.map((item) => [
        item,
        serializedCase.split(item).length - 1,
      ])),
    });
    continue;
  }
  const outputName = `${scenario.id}.json`;
  await writeFile(path.join(caseOutput, outputName), serializedCase);
  cases.push({
    scenarioId: scenario.id,
    category: scenario.category,
    nativeFile: options.caseDirectory ? path.join(options.caseDirectory, outputName) : outputName,
    requestSha256: sha256(requestText),
    modifiedRequestSha256: sha256(`${JSON.stringify(request, null, 2)}\n`),
    removedQuestionOptions,
    expectedPolicy: truth.expectedPolicy,
    acceptableGuidance: truth.acceptableGuidance,
    cautionRequired: truth.cautionRequired,
  });
}

const conversionManifest = {
  schemaVersion: "glaramara-orchestrate-native-conversion/1.0.0",
  sourceSuite: suite.suiteVersion,
  sourceFrozenAt: frozen.frozenAt,
  sourceHashes: frozen.hashes,
  targetAgent: options.agent,
  caseCount: cases.length,
  requestedCaseCount: selected.length,
  excludedCaseCount: excludedCases.length,
  exclusionScan: {
    scope: "complete serialized native evaluation input",
    caseSensitive: true,
    substrings: options.excludeSubstrings,
  },
  transformations: {
    label: options.removeQuestionOptions.length
      ? "modified-input native evaluation subset"
      : "none",
    removedQuestionOptions: options.removeQuestionOptions,
    excludedSelectedPaymentPurposes: options.excludeSelectedPaymentPurposes,
    sourceDatasetModified: false,
  },
  excludedCases,
  cases,
  representation: {
    preservedInNativeCase: ["structured request JSON", "questionnaire answers", "scenario id in transactionRef", "canonical structured evidence"],
    retainedInManifestOnly: ["deterministic policy outcome", "guidance criteria", "caution flag", "source hashes"],
    authoritativeScorer: "independent Glaramara harness",
  },
};
await writeFile(path.join(options.output, "conversion-manifest.json"), `${JSON.stringify(conversionManifest, null, 2)}\n`);
process.stdout.write(
  `Converted and validated ${cases.length} frozen case(s); excluded ${excludedCases.length} in ${options.output}\n`,
);
