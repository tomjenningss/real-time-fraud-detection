import assert from "node:assert/strict";
import test from "node:test";

import {
  reassessFraudEvidence,
  REASSESSMENT_POLICY_VERSION,
} from "../lib/fraud-intelligence/policy.mjs";

const builderEvidence = {
  schemaVersion: "fraud-intelligence-evidence/1.1.0",
  paymentRecognition: "RECOGNISED",
  beneficiaryRelationship: "NEW",
  paymentPurpose: "GOODS_OR_SERVICES",
  thirdPartyInfluence: "NONE",
  verificationClaims: [
    "MET_BENEFICIARY_IN_PERSON",
    "CHECKED_BENEFICIARY_DETAILS",
    "INVOICE_RECEIVED",
  ],
  scamIndicators: ["NONE"],
  uncertainty: "LOW",
  contradictions: [],
  missingEvidence: [],
  provenance: [
    { findingId: "paymentRecognition", sources: [{ questionId: "payment_recognition" }] },
    { findingId: "beneficiaryRelationship", sources: [{ questionId: "beneficiary_relationship" }] },
    { findingId: "paymentPurpose", sources: [{ questionId: "payment_circumstances" }] },
    { findingId: "thirdPartyInfluence", sources: [{ questionId: "contact_influence" }] },
    ...[
      "MET_BENEFICIARY_IN_PERSON",
      "CHECKED_BENEFICIARY_DETAILS",
      "INVOICE_RECEIVED",
    ].map((claim) => ({
      findingId: `verificationClaim:${claim}`,
      sources: [{ questionId: "payment_circumstances" }],
    })),
  ],
};

test("narrow service-payment evidence requires independent additional verification", () => {
  assert.equal(REASSESSMENT_POLICY_VERSION, "customer-evidence-reassessment/1.2.0");
  const result = reassessFraudEvidence(builderEvidence);
  assert.equal(result.outcome, "ADDITIONAL_VERIFICATION");
  assert.deepEqual(result.reasonCodes, [
    "NARROW_SERVICE_PAYMENT_REQUIRES_INDEPENDENT_BENEFICIARY_VERIFICATION",
  ]);
  assert.equal(result.policyTrace[0].ruleId, "CER-ADDITIONAL-VERIFY-NARROW-SERVICE-PAYMENT");
  assert.match(result.policyTrace[0].summary, /does not establish safety/i);
  assert.match(result.policyTrace[0].summary, /independent beneficiary verification/i);
});

test("high-risk indicators override reassuring service-payment claims", () => {
  const result = reassessFraudEvidence({
    ...builderEvidence,
    thirdPartyInfluence: "BANK_IMPERSONATION",
    scamIndicators: ["SAFE_ACCOUNT", "BANK_IMPERSONATION", "URGENCY"],
    provenance: [
      ...builderEvidence.provenance,
      { findingId: "scamIndicator:SAFE_ACCOUNT", sources: [{ questionId: "payment_circumstances" }] },
    ],
  });
  assert.equal(result.outcome, "DECLINED");
  assert.equal(result.policyTrace[0].ruleId, "CER-DECLINE-SAFE-ACCOUNT");
});

test("ambiguous, missing, malformed and unmatched evidence refers to an analyst", () => {
  for (const evidence of [
    null,
    { ...builderEvidence, schemaVersion: "fraud-intelligence-evidence/1.0.0" },
    { ...builderEvidence, uncertainty: "HIGH" },
    { ...builderEvidence, missingEvidence: ["payment_purpose"] },
    { ...builderEvidence, contradictions: [{ summary: "conflict" }] },
    { ...builderEvidence, verificationClaims: [] },
    { ...builderEvidence, scamIndicators: ["URGENCY"] },
  ]) {
    assert.equal(reassessFraudEvidence(evidence).outcome, "REFER_TO_ANALYST");
  }
});

test("unrecognised payments and defined high-risk patterns decline", () => {
  assert.equal(reassessFraudEvidence({
    ...builderEvidence,
    paymentRecognition: "NOT_RECOGNISED",
  }).outcome, "DECLINED");
  assert.equal(reassessFraudEvidence({
    ...builderEvidence,
    scamIndicators: ["REMOTE_ACCESS"],
  }).outcome, "DECLINED");
});
