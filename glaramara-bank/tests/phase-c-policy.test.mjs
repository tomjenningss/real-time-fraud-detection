import assert from "node:assert/strict";
import test from "node:test";

import {
  reassessFraudEvidence,
  REASSESSMENT_POLICY_VERSION,
} from "../lib/fraud-intelligence/policy.mjs";

const baseEvidence = {
  schemaVersion: "fraud-intelligence-evidence/1.0.0",
  paymentRecognition: "RECOGNISED",
  beneficiaryRelationship: "KNOWN",
  scamIndicators: ["NONE"],
  uncertainty: "LOW",
  contradictions: [],
  missingEvidence: [],
};

test("reassessment clears only complete recognised low-risk evidence", () => {
  assert.equal(REASSESSMENT_POLICY_VERSION, "customer-evidence-reassessment/1.0.0");
  assert.deepEqual(reassessFraudEvidence(baseEvidence), {
    outcome: "CLEARED",
    reasonCodes: ["RECOGNISED_WITH_COMPLETE_LOW_RISK_EVIDENCE"],
  });
});

test("unrecognised payment and defined scam evidence decline", () => {
  assert.equal(reassessFraudEvidence({
    ...baseEvidence,
    paymentRecognition: "NOT_RECOGNISED",
  }).outcome, "DECLINED");
  assert.equal(reassessFraudEvidence({
    ...baseEvidence,
    scamIndicators: ["REMOTE_ACCESS"],
  }).outcome, "DECLINED");
});

test("missing, contradictory, uncertain and invalid evidence requires review", () => {
  for (const evidence of [
    null,
    { ...baseEvidence, schemaVersion: "unknown" },
    { ...baseEvidence, uncertainty: "HIGH" },
    { ...baseEvidence, missingEvidence: ["payment_purpose"] },
    { ...baseEvidence, contradictions: [{ summary: "conflict" }] },
    { ...baseEvidence, scamIndicators: ["INVESTMENT"] },
  ]) {
    assert.equal(reassessFraudEvidence(evidence).outcome, "REQUIRES_FURTHER_REVIEW");
  }
});
