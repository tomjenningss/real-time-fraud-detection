export const REASSESSMENT_POLICY_VERSION = "customer-evidence-reassessment/1.0.0";

const DECLINE_INDICATORS = new Set([
  "SAFE_ACCOUNT",
  "REMOTE_ACCESS",
  "IMPERSONATION",
  "PRESSURE_OR_SECRECY",
]);

export function reassessFraudEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== "fraud-intelligence-evidence/1.0.0") {
    return { outcome: "REQUIRES_FURTHER_REVIEW", reasonCodes: ["INVALID_EVIDENCE_SCHEMA"] };
  }
  if (evidence.paymentRecognition === "NOT_RECOGNISED") {
    return { outcome: "DECLINED", reasonCodes: ["CUSTOMER_DID_NOT_RECOGNISE_PAYMENT"] };
  }
  const declineIndicators = evidence.scamIndicators.filter((item) => DECLINE_INDICATORS.has(item));
  if (declineIndicators.length > 0) {
    return {
      outcome: "DECLINED",
      reasonCodes: declineIndicators.map((item) => `SCAM_INDICATOR_${item}`),
    };
  }
  if (
    evidence.paymentRecognition !== "RECOGNISED" ||
    evidence.beneficiaryRelationship === "UNCERTAIN" ||
    evidence.uncertainty !== "LOW" ||
    evidence.contradictions.length > 0 ||
    evidence.missingEvidence.length > 0
  ) {
    return { outcome: "REQUIRES_FURTHER_REVIEW", reasonCodes: ["EVIDENCE_NOT_CLEAR"] };
  }
  if (evidence.scamIndicators.length > 0 && !evidence.scamIndicators.includes("NONE")) {
    return { outcome: "REQUIRES_FURTHER_REVIEW", reasonCodes: ["SCAM_INDICATORS_REQUIRE_REVIEW"] };
  }
  return { outcome: "CLEARED", reasonCodes: ["RECOGNISED_WITH_COMPLETE_LOW_RISK_EVIDENCE"] };
}
