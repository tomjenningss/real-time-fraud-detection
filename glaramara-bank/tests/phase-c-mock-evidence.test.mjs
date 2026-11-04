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
  assert.equal(evidence.schemaVersion, "fraud-intelligence-evidence/1.1.0");
  assert.equal(evidence.paymentPurpose, "GOODS_OR_SERVICES");
  assert.equal(evidence.thirdPartyInfluence, "NONE");
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
  assert.equal(evidence.thirdPartyInfluence, "UNEXPECTED");
  assert.deepEqual(new Set(evidence.scamIndicators), new Set([
    "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "THIRD_PARTY_BENEFICIARY",
  ]));
  assert.equal(evidence.uncertainty, "MEDIUM");
});
