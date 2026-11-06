#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildFraudPreventionGuidance } from "../../../glaramara-bank/lib/fraud-intelligence/guidance.mjs";
import { reassessFraudEvidence } from "../../../glaramara-bank/lib/fraud-intelligence/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "paymentRecognition", "beneficiaryRelationship", "paymentPurpose",
  "thirdPartyInfluence", "verificationClaims", "scamIndicators", "contradictions",
  "uncertainty", "missingEvidence", "provenance", "clarificationQuestion",
]);

const QUESTIONS = {
  payment_recognition: ["Did you make this payment yourself?", ["YES", "NO", "UNSURE"]],
  beneficiary_relationship: ["How do you know the person or business you’re paying?", [
    "KNOWN_PERSON", "KNOWN_BUSINESS", "NEW_RECIPIENT", "UNSURE",
  ]],
  payment_purpose: ["What is this payment for?", [
    "FRIENDS_FAMILY", "GOODS_SERVICES", "INVESTMENT", "SAFE_ACCOUNT", "OTHER",
  ]],
  contact_influence: ["Did anyone contact you or guide you through making this payment?", [
    "NO", "EXPECTED", "UNEXPECTED",
  ]],
  payment_circumstances: ["Briefly explain what happened and why this payment feels urgent.", null],
  other_purpose: ["Tell us what the payment is for.", null],
  pressure_or_secrecy: [
    "Did they ask you to act quickly, keep it secret, or ignore a bank warning?",
    ["YES", "NO", "UNSURE"],
  ],
  remote_access: [
    "Did anyone ask you to install an app or share access to your phone or computer?",
    ["YES", "NO", "UNSURE"],
  ],
};

export function buildContext(scenario) {
  const questions = Object.keys(scenario.answers).map((id) => {
    const [prompt, options] = QUESTIONS[id];
    return options ? { id, prompt, options } : { id, prompt };
  });
  return {
    schemaVersion: "fraud-intelligence-request/1.0.0",
    questionnaireVersion: "glaramara-fraud-questionnaire/1.1.0",
    transactionRef: `evaluation-${scenario.id}`,
    payment: {
      amount: scenario.payment?.amount ?? 5_000,
      currency: "GBP",
      beneficiaryPreviouslyPaid: scenario.payment?.beneficiaryPreviouslyPaid ?? false,
    },
    deterministicSignals: scenario.payment?.deterministicSignals ?? ["NEW_BENEFICIARY_HIGH_VALUE"],
    requiredEvidenceKeys: ["payment_recognition", "beneficiary_relationship", "payment_purpose"],
    questions,
    answers: Object.entries(scenario.answers).map(([questionId, value]) => ({
      questionId, value, provenance: "CUSTOMER",
    })),
  };
}

function sourceForFinding(findingId, evidence, answers) {
  if (findingId === "paymentRecognition") return "payment_recognition";
  if (findingId === "beneficiaryRelationship") return "beneficiary_relationship";
  if (findingId === "paymentPurpose") return "payment_purpose";
  if (findingId === "thirdPartyInfluence") {
    return evidence.thirdPartyInfluence === "BANK_IMPERSONATION"
      ? "payment_circumstances" : "contact_influence";
  }
  if (findingId.startsWith("verificationClaim:")) return "payment_circumstances";
  const indicator = findingId.replace("scamIndicator:", "");
  const source = {
    UNEXPECTED_CONTACT: "contact_influence",
    PRESSURE_OR_SECRECY: "pressure_or_secrecy",
    REMOTE_ACCESS: "remote_access",
    SAFE_ACCOUNT: answers.payment_purpose === "SAFE_ACCOUNT"
      ? "payment_purpose" : "payment_circumstances",
    INVESTMENT: "payment_purpose",
  }[indicator];
  return source ?? "payment_circumstances";
}

export function canonicalEvidence(scenario) {
  const expected = scenario.expectedEvidence;
  const evidence = {
    schemaVersion: "fraud-intelligence-evidence/1.1.0",
    paymentRecognition: expected.paymentRecognition,
    beneficiaryRelationship: expected.beneficiaryRelationship,
    paymentPurpose: expected.paymentPurpose,
    thirdPartyInfluence: expected.thirdPartyInfluence,
    verificationClaims: expected.verificationClaims,
    scamIndicators: expected.requiredIndicators,
    contradictions: expected.contradictions ?? [],
    uncertainty: expected.uncertainty,
    missingEvidence: expected.missingEvidence ?? [],
    provenance: [],
    clarificationQuestion: { needed: false, id: "", prompt: "", options: [], reason: "" },
  };
  const requiredFindings = [
    "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
    ...expected.verificationClaims.map((claim) => `verificationClaim:${claim}`),
    ...expected.requiredIndicators.filter((indicator) => indicator !== "NONE")
      .map((indicator) => `scamIndicator:${indicator}`),
  ];
  for (const findingId of requiredFindings) {
    const questionId = expected.provenanceSources?.[findingId]
      ?? sourceForFinding(findingId, evidence, scenario.answers);
    const excerpt = scenario.answers[questionId];
    assert.equal(typeof excerpt, "string", `${scenario.id}: no source answer for ${findingId}`);
    evidence.provenance.push({
      findingId,
      claim: `Expected evaluation finding ${findingId}`,
      sources: [{ questionId, excerpt }],
    });
  }
  return evidence;
}

function findEvidence(value) {
  if (typeof value === "string") {
    const candidate = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return findEvidence(JSON.parse(candidate)); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEvidence(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if (
      value.schemaVersion === "fraud-intelligence-evidence/1.1.0"
      && Object.hasOwn(value, "paymentRecognition")
      && Object.hasOwn(value, "beneficiaryRelationship")
      && Object.hasOwn(value, "paymentPurpose")
      && Object.hasOwn(value, "thirdPartyInfluence")
      && Array.isArray(value.scamIndicators)
      && Array.isArray(value.provenance)
    ) return value;
    for (const item of Object.values(value)) {
      const found = findEvidence(item);
      if (found) return found;
    }
  }
  return null;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

function exactEvidenceKey(evidence) {
  return JSON.stringify(sortObject(evidence));
}

function semanticEvidenceKey(evidence) {
  const sorted = (values) => [...(values ?? [])].sort();
  const provenance = (evidence.provenance ?? []).map((item) => ({
    findingId: item.findingId,
    sources: (item.sources ?? []).map((source) => ({
      questionId: source.questionId,
      excerpt: source.excerpt,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).sort((left, right) => left.findingId.localeCompare(right.findingId));
  const contradictions = (evidence.contradictions ?? []).map((item) => ({
    sourceQuestionIds: sorted(item.sourceQuestionIds),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    paymentRecognition: evidence.paymentRecognition,
    beneficiaryRelationship: evidence.beneficiaryRelationship,
    paymentPurpose: evidence.paymentPurpose,
    thirdPartyInfluence: evidence.thirdPartyInfluence,
    verificationClaims: sorted(evidence.verificationClaims),
    scamIndicators: sorted(evidence.scamIndicators),
    contradictions,
    uncertainty: evidence.uncertainty,
    missingEvidence: sorted(evidence.missingEvidence),
    provenance,
    clarificationQuestion: sortObject(evidence.clarificationQuestion),
  });
}

function gradeExtraction(scenario, candidate) {
  const failures = [];
  const expected = scenario.expectedEvidence;
  const context = buildContext(scenario);
  if (!candidate) return { status: "NOT_RUN", failures: ["no extraction result supplied"] };
  if (JSON.stringify([...Object.keys(candidate)].sort())
      !== JSON.stringify([...TOP_LEVEL_KEYS].sort())) {
    failures.push("top-level keys do not exactly match the v1.1 contract");
  }
  const enums = {
    paymentRecognition: ["RECOGNISED", "NOT_RECOGNISED", "UNCERTAIN"],
    beneficiaryRelationship: ["KNOWN", "NEW", "UNCERTAIN"],
    paymentPurpose: ["GOODS_OR_SERVICES", "FRIENDS_OR_FAMILY", "INVESTMENT", "SAFE_ACCOUNT", "OTHER", "UNCERTAIN"],
    thirdPartyInfluence: ["NONE", "EXPECTED", "UNEXPECTED", "BANK_IMPERSONATION", "UNCERTAIN"],
    uncertainty: ["LOW", "MEDIUM", "HIGH"],
  };
  for (const [field, allowed] of Object.entries(enums)) {
    if (!allowed.includes(candidate[field])) failures.push(`${field} is outside the schema enum`);
  }
  for (const field of [
    "verificationClaims", "scamIndicators", "contradictions", "missingEvidence", "provenance",
  ]) {
    if (!Array.isArray(candidate[field])) failures.push(`${field} is not an array`);
  }
  for (const field of ["verificationClaims", "scamIndicators", "missingEvidence"]) {
    if (Array.isArray(candidate[field]) && new Set(candidate[field]).size !== candidate[field].length) {
      failures.push(`${field} contains duplicate values`);
    }
  }
  for (const field of [
    "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence", "uncertainty",
  ]) {
    if (candidate[field] !== expected[field]) {
      failures.push(`${field}: expected ${expected[field]}, observed ${String(candidate[field])}`);
    }
  }
  if (JSON.stringify([...(candidate.verificationClaims ?? [])].sort())
      !== JSON.stringify([...expected.verificationClaims].sort())) {
    failures.push("verificationClaims did not match exactly");
  }
  for (const indicator of expected.requiredIndicators) {
    if (!candidate.scamIndicators?.includes(indicator)) failures.push(`missing required indicator ${indicator}`);
  }
  for (const indicator of expected.forbiddenIndicators) {
    if (candidate.scamIndicators?.includes(indicator)) failures.push(`invented forbidden indicator ${indicator}`);
  }
  if (candidate.scamIndicators?.includes("NONE") && candidate.scamIndicators.length !== 1) {
    failures.push("NONE was combined with another scam indicator");
  }
  if ((candidate.contradictions?.length ?? 0) < (expected.minimumContradictions ?? 0)) {
    failures.push(`expected at least ${expected.minimumContradictions} contradiction(s)`);
  }
  const answers = new Map(context.answers.map((answer) => [answer.questionId, answer.value]));
  const provenance = Array.isArray(candidate.provenance) ? candidate.provenance : [];
  const findingIds = new Set(provenance.map((item) => item?.findingId));
  if (findingIds.size !== provenance.length) failures.push("provenance findingIds are not unique");
  const actualRequiredFindings = [
    "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
    ...(candidate.verificationClaims ?? []).map((claim) => `verificationClaim:${claim}`),
    ...(candidate.scamIndicators ?? []).filter((indicator) => indicator !== "NONE")
      .map((indicator) => `scamIndicator:${indicator}`),
  ];
  for (const findingId of actualRequiredFindings) {
    if (!findingIds.has(findingId)) failures.push(`schema-required provenance is absent for ${findingId}`);
  }
  for (const findingId of expected.requiredProvenance) {
    if (!findingIds.has(findingId)) failures.push(`missing provenance for ${findingId}`);
  }
  for (const findingId of expected.forbiddenProvenance ?? []) {
    if (findingIds.has(findingId)) failures.push(`invented provenance for ${findingId}`);
  }
  for (const item of provenance) {
    if (!Array.isArray(item?.sources) || item.sources.length === 0) {
      failures.push(`provenance ${String(item?.findingId)} has no sources`);
      continue;
    }
    for (const source of item.sources) {
      const answer = answers.get(source?.questionId);
      if (typeof answer !== "string" || typeof source?.excerpt !== "string"
          || !answer.includes(source.excerpt)) {
        failures.push(`provenance ${String(item.findingId)} has a non-verbatim source excerpt`);
      }
    }
  }
  const clarification = candidate.clarificationQuestion;
  if (!clarification || typeof clarification !== "object"
      || JSON.stringify(Object.keys(clarification).sort())
        !== JSON.stringify(["needed", "id", "prompt", "options", "reason"].sort())) {
    failures.push("clarificationQuestion does not match the strict object contract");
  } else if (clarification.needed === false
      && (clarification.id || clarification.prompt || clarification.reason
        || !Array.isArray(clarification.options) || clarification.options.length > 0)) {
    failures.push("unused clarificationQuestion contains non-empty values");
  }
  return { status: failures.length === 0 ? "PASS" : "FAIL", failures };
}

function gradePolicy(scenario, evidence) {
  const observed = reassessFraudEvidence(evidence);
  const ruleId = observed.policyTrace?.[0]?.ruleId;
  const failures = [];
  if (observed.outcome !== scenario.expectedPolicy.outcome) {
    failures.push(`outcome: expected ${scenario.expectedPolicy.outcome}, observed ${observed.outcome}`);
  }
  if (ruleId !== scenario.expectedPolicy.ruleId) {
    failures.push(`rule: expected ${scenario.expectedPolicy.ruleId}, observed ${String(ruleId)}`);
  }
  return { status: failures.length === 0 ? "PASS" : "FAIL", failures, observed };
}

function gradeGuidance(scenario, evidence, policy) {
  const guidance = buildFraudPreventionGuidance({
    evidence,
    reassessment: policy,
    customerExplanation: scenario.answers.payment_circumstances ?? null,
    context: buildContext(scenario).payment,
  });
  const rendered = [
    guidance.rendered.heading, guidance.rendered.context, ...guidance.rendered.steps,
    guidance.rendered.paymentStatus, guidance.rendered.simulationNotice,
  ].join("\n");
  const failures = [];
  if (guidance.category !== scenario.expectedGuidance.category) {
    failures.push(`category: expected ${scenario.expectedGuidance.category}, observed ${guidance.category}`);
  }
  for (const text of scenario.expectedGuidance.requiredText) {
    if (!rendered.toLowerCase().includes(text.toLowerCase())) failures.push(`missing grounded text: ${text}`);
  }
  for (const text of scenario.expectedGuidance.forbiddenText) {
    if (rendered.toLowerCase().includes(text.toLowerCase())) failures.push(`contains unsupported text: ${text}`);
  }
  const status = failures.length === 0 ? "PASS"
    : scenario.knownFailingGuidanceRegression ? "KNOWN_FAIL" : "FAIL";
  return { status, failures, observed: guidance };
}

async function loadExternalResults(resultPath) {
  if (!resultPath) return new Map();
  const statEntries = await readdir(resultPath, { recursive: true, withFileTypes: true });
  const results = new Map();
  for (const entry of statEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
    let parsed;
    try { parsed = JSON.parse(await readFile(fullPath, "utf8")); } catch { continue; }
    const evidence = findEvidence(parsed);
    if (!evidence && !parsed.executionError) continue;
    const add = (scenarioId) => {
      const existing = results.get(scenarioId) ?? [];
      existing.push({
        transport: parsed.transport ?? "unspecified",
        evidence,
        executionError: parsed.executionError ?? null,
      });
      results.set(scenarioId, existing);
    };
    const serialized = JSON.stringify(parsed);
    for (const match of serialized.matchAll(/evaluation-([a-z0-9-]+)/g)) {
      add(match[1]);
    }
    const explicitId = parsed.scenarioId ?? parsed.id ?? parsed.name;
    if (typeof explicitId === "string") add(explicitId);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const suitePath = valueAfter("--suite") ?? path.join(HERE, "scenarios.json");
  const externalResults = await loadExternalResults(valueAfter("--extraction-results"));
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  const scenarios = suite.scenarios.map((scenario) => {
    const evidence = canonicalEvidence(scenario);
    const suppliedExtractions = externalResults.get(scenario.id) ?? [];
    const extractionRuns = suppliedExtractions.map((item) => item.executionError
      ? { transport: item.transport, status: "FAIL", failures: [`live invocation error: ${item.executionError}`] }
      : { transport: item.transport, ...gradeExtraction(scenario, item.evidence) });
    const successfulExtractions = suppliedExtractions.filter((item) => item.evidence);
    const consistency = successfulExtractions.length < 2 ? null : {
      runCount: successfulExtractions.length,
      exact: new Set(successfulExtractions.map((item) => exactEvidenceKey(item.evidence))).size === 1,
      semantic: new Set(successfulExtractions.map((item) => semanticEvidenceKey(item.evidence))).size === 1,
    };
    const extraction = extractionRuns.length === 0
      ? { status: "NOT_RUN", failures: ["no extraction result supplied"], runs: [], consistency: null }
      : {
          status: extractionRuns.some((item) => item.status === "FAIL") ? "FAIL" : "PASS",
          failures: extractionRuns.flatMap((item) => item.failures),
          runs: extractionRuns,
          consistency,
        };
    const policy = gradePolicy(scenario, evidence);
    const guidance = gradeGuidance(scenario, evidence, policy.observed);
    return {
      id: scenario.id,
      category: scenario.category,
      extraction,
      policy: { status: policy.status, failures: policy.failures },
      guidance: { status: guidance.status, failures: guidance.failures },
      unsupportedConcepts: scenario.unsupportedConcepts ?? [],
      knownFailingGuidanceRegression: scenario.knownFailingGuidanceRegression ?? false,
    };
  });
  const count = (layer, status) => scenarios.filter((item) => item[layer].status === status).length;
  const extractionRuns = scenarios.flatMap((item) => item.extraction.runs);
  const report = {
    generatedAt: new Date().toISOString(),
    suiteVersion: suite.suiteVersion,
    scenarioCount: scenarios.length,
    execution: {
      extractionResultsSupplied: extractionRuns.length,
      extraction: {
        pass: count("extraction", "PASS"), fail: count("extraction", "FAIL"),
        notRun: count("extraction", "NOT_RUN"),
        transportRuns: {
          pass: extractionRuns.filter((item) => item.status === "PASS").length,
          fail: extractionRuns.filter((item) => item.status === "FAIL").length,
        },
      },
      policy: { pass: count("policy", "PASS"), fail: count("policy", "FAIL") },
      guidance: { pass: count("guidance", "PASS"), fail: count("guidance", "FAIL"), knownFail: count("guidance", "KNOWN_FAIL") },
    },
    unsupportedConcepts: [...new Set(scenarios.flatMap((item) => item.unsupportedConcepts))].sort(),
    scenarios,
  };
  const outputPath = valueAfter("--output");
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const unexpectedFailures = scenarios.some((item) => item.policy.status === "FAIL"
    || item.guidance.status === "FAIL" || item.extraction.status === "FAIL");
  process.exitCode = unexpectedFailures ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
