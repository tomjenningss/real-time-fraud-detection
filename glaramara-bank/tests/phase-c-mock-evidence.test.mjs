import assert from "node:assert/strict";
import test from "node:test";

import { buildMockEvidence } from "../lib/fraud-intelligence/mock-evidence.mjs";

function context(answers) {
  return {
    requiredEvidenceKeys: ["payment_recognition", "beneficiary_relationship", "payment_purpose"],
    answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
  };
}

test("mock extraction maps complete low-risk answers deterministically", () => {
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "KNOWN_PERSON",
    payment_purpose: "FRIENDS_FAMILY",
    contact_influence: "NO",
  }));
  assert.equal(evidence.schemaVersion, "fraud-intelligence-evidence/1.0.0");
  assert.equal(evidence.paymentRecognition, "RECOGNISED");
  assert.equal(evidence.beneficiaryRelationship, "KNOWN");
  assert.deepEqual(evidence.scamIndicators, ["NONE"]);
  assert.equal(evidence.uncertainty, "LOW");
});

test("mock extraction preserves scam indicators and question provenance", () => {
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "SAFE_ACCOUNT",
    contact_influence: "UNEXPECTED",
    pressure_or_secrecy: "YES",
    remote_access: "YES",
  }));
  assert.deepEqual(new Set(evidence.scamIndicators), new Set([
    "SAFE_ACCOUNT", "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "REMOTE_ACCESS",
  ]));
  assert.ok(evidence.provenance.every((item) => item.sourceQuestionIds.length === 1));
});

test("mock extraction makes missing required evidence conservative", () => {
  const evidence = buildMockEvidence(context({ payment_recognition: "UNSURE" }));
  assert.equal(evidence.paymentRecognition, "UNCERTAIN");
  assert.equal(evidence.uncertainty, "HIGH");
  assert.deepEqual(evidence.missingEvidence, ["beneficiary_relationship", "payment_purpose"]);
});
