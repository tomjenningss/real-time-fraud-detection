export function buildMockEvidence(context) {
  const answers = Object.fromEntries(context.answers.map((answer) => [answer.questionId, answer.value]));
  const paymentRecognition = answers.payment_recognition === "YES"
    ? "RECOGNISED"
    : answers.payment_recognition === "NO" ? "NOT_RECOGNISED" : "UNCERTAIN";
  const beneficiaryRelationship = ["KNOWN_PERSON", "KNOWN_BUSINESS"].includes(
    answers.beneficiary_relationship,
  )
    ? "KNOWN"
    : answers.beneficiary_relationship === "NEW_RECIPIENT" ? "NEW" : "UNCERTAIN";
  const indicators = new Set();
  if (answers.contact_influence === "UNEXPECTED") indicators.add("UNEXPECTED_CONTACT");
  if (answers.pressure_or_secrecy === "YES") indicators.add("PRESSURE_OR_SECRECY");
  if (answers.remote_access === "YES") indicators.add("REMOTE_ACCESS");
  if (answers.payment_purpose === "SAFE_ACCOUNT") indicators.add("SAFE_ACCOUNT");
  if (answers.payment_purpose === "INVESTMENT") indicators.add("INVESTMENT");
  if (indicators.size === 0) indicators.add("NONE");
  const missingEvidence = context.requiredEvidenceKeys.filter((key) => !answers[key]);
  const uncertain = paymentRecognition === "UNCERTAIN" || beneficiaryRelationship === "UNCERTAIN";
  return {
    schemaVersion: "fraud-intelligence-evidence/1.0.0",
    paymentRecognition,
    beneficiaryRelationship,
    scamIndicators: [...indicators],
    contradictions: [],
    uncertainty: missingEvidence.length > 0 ? "HIGH" : uncertain ? "MEDIUM" : "LOW",
    missingEvidence,
    provenance: context.answers.map((answer) => ({
      claim: `${answer.questionId}=${answer.value}`,
      sourceQuestionIds: [answer.questionId],
    })),
    clarificationQuestion: { needed: false, id: "", prompt: "", options: [], reason: "" },
  };
}
