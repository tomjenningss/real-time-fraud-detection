import assert from "node:assert/strict";
import test from "node:test";

import { buildMockEvidence } from "../lib/fraud-intelligence/mock-evidence.mjs";

function context(answers) {
  return {
    requiredEvidenceKeys: ["payment_recognition", "beneficiary_relationship", "payment_purpose"],
    answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
  };
}

test("builder explanation produces source-linked customer-stated verification claims", () => {
  const explanation = "I’m paying a builder for the kitchen renovation. I’ve met him, checked his details and received an invoice.";
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "GOODS_SERVICES",
    contact_influence: "NO",
    payment_circumstances: explanation,
  }));
  assert.equal(evidence.schemaVersion, "fraud-intelligence-evidence/1.2.0");
  assert.equal(evidence.paymentPurpose, "GOODS_OR_SERVICES");
  assert.equal(evidence.thirdPartyInfluence, "SELF_DECIDED");
  assert.deepEqual(new Set(evidence.verificationClaims), new Set([
    "MET_BENEFICIARY_IN_PERSON",
    "CHECKED_BENEFICIARY_DETAILS",
    "INVOICE_RECEIVED",
  ]));
  assert.deepEqual(evidence.scamIndicators, ["NONE"]);
  assert.ok(evidence.provenance.some((item) => item.sources.some(
    (source) => source.questionId === "payment_circumstances" && source.excerpt === explanation,
  )));
});

test("safe-account explanation extracts bank impersonation, urgency and exact provenance", () => {
  const explanation = "Someone from my bank called and told me my account was compromised. They said I need to transfer the money to a safe account immediately.";
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "SAFE_ACCOUNT",
    contact_influence: "UNEXPECTED",
    payment_circumstances: explanation,
    pressure_or_secrecy: "YES",
    remote_access: "NO",
  }));
  assert.equal(evidence.thirdPartyInfluence, "BANK_IMPERSONATION");
  assert.deepEqual(new Set(evidence.scamIndicators), new Set([
    "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "SAFE_ACCOUNT",
    "BANK_IMPERSONATION", "URGENCY",
  ]));
  assert.ok(evidence.provenance.every((item) => item.sources.every(
    (source) => Object.values({
      payment_recognition: "YES",
      beneficiary_relationship: "NEW_RECIPIENT",
      payment_purpose: "SAFE_ACCOUNT",
      contact_influence: "UNEXPECTED",
      payment_circumstances: explanation,
      pressure_or_secrecy: "YES",
      remote_access: "NO",
    }) .includes(source.excerpt),
  )));
});

test("missing and uncertain evidence remains conservative", () => {
  const evidence = buildMockEvidence(context({ payment_recognition: "UNSURE" }));
  assert.equal(evidence.paymentRecognition, "UNCERTAIN");
  assert.equal(evidence.uncertainty, "HIGH");
  assert.deepEqual(evidence.missingEvidence, ["beneficiary_relationship", "payment_purpose"]);
});

test("unexpected family-help narrative keeps influence and indicators distinct", () => {
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "FRIENDS_FAMILY",
    contact_influence: "UNEXPECTED",
    payment_circumstances: "An unknown number sounded like my daughter and her friend can take out the money.",
    pressure_or_secrecy: "YES",
    remote_access: "UNSURE",
  }));
  assert.equal(evidence.thirdPartyInfluence, "THIRD_PARTY_INFLUENCED");
  assert.deepEqual(new Set(evidence.scamIndicators), new Set([
    "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "THIRD_PARTY_BENEFICIARY",
  ]));
  assert.equal(evidence.uncertainty, "MEDIUM");
});

test("investment answers preserve origin, reason, influence and relationship claims", () => {
  const reason = "I am investing with a regulated provider I already use for my pension.";
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "BUSINESS_OR_ORGANISATION",
    payment_purpose: "INVESTMENT",
    contact_influence: "SELF_DECIDED",
    investment_origin: "KNOWN_PROVIDER",
    investment_reason: reason,
  }));
  assert.equal(evidence.beneficiaryRelationship, "BUSINESS_OR_ORGANISATION");
  assert.equal(evidence.paymentPurpose, "INVESTMENT");
  assert.equal(evidence.thirdPartyInfluence, "SELF_DECIDED");
  assert.deepEqual(evidence.scamIndicators, ["INVESTMENT"]);
  assert.ok(evidence.provenance.some((item) => item.findingId === "scamIndicator:INVESTMENT"));
  assert.doesNotMatch(JSON.stringify(evidence), /pressure|urgency|guaranteed/i);
});

test("current relationship values and saved online-only answers map without deriving payment history", () => {
  const evidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "FRIEND_OR_FAMILY",
    payment_purpose: "GOODS_SERVICES",
    contact_influence: "DISCUSSION_ONLY",
  }));
  assert.equal(evidence.beneficiaryRelationship, "FRIEND_OR_FAMILY");
  assert.equal(evidence.thirdPartyInfluence, "DISCUSSION_ONLY");

  const savedAnswerEvidence = buildMockEvidence(context({
    payment_recognition: "YES",
    beneficiary_relationship: "ONLINE_ONLY",
    payment_purpose: "GOODS_SERVICES",
    contact_influence: "DISCUSSION_ONLY",
  }));
  assert.equal(savedAnswerEvidence.beneficiaryRelationship, "INDIVIDUAL_NOT_PERSONALLY_KNOWN");
});
