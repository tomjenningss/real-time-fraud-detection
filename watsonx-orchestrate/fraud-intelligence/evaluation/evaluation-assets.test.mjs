import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const HERE = new URL(".", import.meta.url);
const execFileAsync = promisify(execFile);

test("investment influencer regression requires grounded investment evidence", async () => {
  const suite = JSON.parse(await readFile(new URL("scenarios.json", HERE), "utf8"));
  const scenario = suite.scenarios.find(
    ({ id }) => id === "investment-influencer-urgent-returns-regression",
  );

  assert.ok(scenario);
  assert.equal(scenario.answers.payment_purpose, "INVESTMENT");
  assert.equal(scenario.expectedEvidence.paymentPurpose, "INVESTMENT");
  assert.ok(scenario.expectedEvidence.requiredIndicators.includes("INVESTMENT"));
  assert.ok(
    scenario.expectedEvidence.requiredProvenance.includes("scamIndicator:INVESTMENT"),
  );
  assert.ok(scenario.expectedEvidence.forbiddenIndicators.includes("BANK_IMPERSONATION"));
});

test("agent instructions make investment and emergency mappings explicit", async () => {
  const agent = await readFile(new URL("../agent.yaml", HERE), "utf8");

  assert.match(agent, /version: 1\.2\.1/);
  assert.match(agent, /whenever paymentPurpose is INVESTMENT, scamIndicators must contain/);
  assert.match(agent, /scamIndicator:INVESTMENT/);
  assert.match(agent, /Never add BANK_IMPERSONATION unless the\s+customer explicitly described claimed bank contact/);
  assert.match(agent, /EXPECTED -> DISCUSSION_ONLY and UNEXPECTED -> THIRD_PARTY_INFLUENCED/);
  assert.match(agent, /explicit emergency or immediate financial assistance requires\s+URGENCY/);
  assert.match(agent, /explicit third-party payment or withdrawal directions require THIRD_PARTY_BENEFICIARY/);
});

test("application validation rejects bounded-answer and indicator invariant violations", async () => {
  const validation = await readFile(
    new URL("../../../glaramara-bank/lib/fraud-intelligence/evidence.ts", HERE),
    "utf8",
  );

  assert.match(validation, /violates the bounded \$\{questionId\}=\$\{answer\} mapping/);
  assert.match(validation, /contact_influence", "UNEXPECTED", "UNEXPECTED_CONTACT"/);
  assert.match(validation, /payment_purpose", "INVESTMENT", "INVESTMENT"/);
  assert.match(validation, /Supplied uncertainty or contradictions require MEDIUM uncertainty/);
});

test("native cases retain the exact FRIENDS_FAMILY questionnaire value", async () => {
  const nativeCase = await readFile(
    new URL("native-cases/family-expected-help.json", HERE),
    "utf8",
  );

  assert.match(nativeCase, /FRIENDS_FAMILY/);
});

test("independent-50 converter preserves requests and manifest-only scoring criteria", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "glaramara-native-poc-"));
  const converter = new URL("convert_independent_50_to_native.mjs", HERE);
  const ids = [
    "investment-crypto-liquidity-release",
    "legitimate-builder-stage-payment",
    "ambiguous-beneficiary-trading-name",
  ];
  await execFileAsync(process.execPath, [converter.pathname, "--output", output,
    ...ids.flatMap((id) => ["--id", id])]);

  const manifest = JSON.parse(await readFile(path.join(output, "conversion-manifest.json"), "utf8"));
  assert.equal(manifest.caseCount, 3);
  assert.equal(manifest.representation.authoritativeScorer, "independent Glaramara harness");
  assert.deepEqual(manifest.cases.map(({ scenarioId }) => scenarioId), ids);

  for (const id of ids) {
    const source = JSON.parse(await readFile(
      new URL(`model-benchmark-independent-50/requests/${id}.json`, HERE), "utf8"));
    const nativeCase = JSON.parse(await readFile(path.join(output, `${id}.json`), "utf8"));
    assert.deepEqual(JSON.parse(nativeCase.story), source);
    assert.deepEqual(JSON.parse(nativeCase.starting_sentence), source);
    assert.equal(JSON.parse(nativeCase.goal_details[0].response).schemaVersion,
      "fraud-intelligence-evidence/1.1.0");
  }
});

test("native-compatible conversion excludes every complete input containing END", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "glaramara-native-compatible-"));
  const converter = new URL("convert_independent_50_to_native.mjs", HERE);
  await execFileAsync(process.execPath, [converter.pathname, "--output", output,
    "--exclude-substring", "END"]);

  const manifest = JSON.parse(await readFile(path.join(output, "conversion-manifest.json"), "utf8"));
  assert.equal(manifest.requestedCaseCount, 50);
  assert.equal(manifest.caseCount + manifest.excludedCaseCount, 50);
  assert.equal(manifest.excludedCases.length, 50);
  assert.equal(manifest.caseCount, 0);
  assert.ok(manifest.excludedCases.every(({ matchedSubstrings }) => matchedSubstrings.includes("END")));
  assert.ok(manifest.excludedCases.every(({ questionnaireOptionsContainMatch }) =>
    questionnaireOptionsContainMatch));
  assert.ok(manifest.excludedCases.some(({ scenarioId }) => scenarioId === "family-ai-voice-grandson-bail"));

  for (const { nativeFile } of manifest.cases) {
    const completeInput = await readFile(path.join(output, nativeFile), "utf8");
    assert.equal(completeInput.includes("END"), false, nativeFile);
  }
});

test("modified-input subset removes only the unused FRIENDS_FAMILY option and retains 37 cases", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "glaramara-native-modified-"));
  const converter = new URL("convert_independent_50_to_native.mjs", HERE);
  await execFileAsync(process.execPath, [converter.pathname, "--output", output,
    "--remove-question-option", "FRIENDS_FAMILY",
    "--exclude-selected-payment-purpose", "FRIENDS_FAMILY",
    "--exclude-substring", "END",
    "--agent", "temporary_evaluation_agent"]);

  const manifest = JSON.parse(await readFile(path.join(output, "conversion-manifest.json"), "utf8"));
  assert.equal(manifest.caseCount, 37);
  assert.equal(manifest.excludedCaseCount, 13);
  assert.equal(manifest.targetAgent, "temporary_evaluation_agent");
  assert.equal(manifest.transformations.label, "modified-input native evaluation subset");
  assert.ok(manifest.excludedCases.every(({ selectedPaymentPurpose }) =>
    selectedPaymentPurpose === "FRIENDS_FAMILY"));

  for (const { nativeFile, removedQuestionOptions } of manifest.cases) {
    const completeInput = await readFile(path.join(output, nativeFile), "utf8");
    const nativeCase = JSON.parse(completeInput);
    const request = JSON.parse(nativeCase.story);
    const purpose = request.questions.find(({ id }) => id === "payment_purpose");
    assert.equal(completeInput.includes("END"), false, nativeFile);
    assert.equal(purpose.options.includes("FRIENDS_FAMILY"), false, nativeFile);
    assert.deepEqual(removedQuestionOptions,
      [{ questionId: "payment_purpose", option: "FRIENDS_FAMILY" }]);
    assert.equal(nativeCase.agent, "temporary_evaluation_agent");
  }
});
