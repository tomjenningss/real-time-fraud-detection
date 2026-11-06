const PURPOSES = {
  GOODS_SERVICES: "GOODS_OR_SERVICES",
  FRIENDS_FAMILY: "FRIENDS_OR_FAMILY",
  INVESTMENT: "INVESTMENT",
  SAFE_ACCOUNT: "SAFE_ACCOUNT",
  OTHER: "OTHER",
};

export function buildMockEvidence(context) {
  const answers = Object.fromEntries(context.answers.map((answer) => [answer.questionId, answer.value]));
  const circumstances = answers.investment_reason ?? answers.payment_circumstances ?? answers.other_purpose ?? "";
  const lower = circumstances.toLowerCase();
  const paymentRecognition = answers.payment_recognition === "YES"
    ? "RECOGNISED"
    : answers.payment_recognition === "NO" ? "NOT_RECOGNISED" : "UNCERTAIN";
  const beneficiaryRelationship = ({
    FRIEND_OR_FAMILY: "FRIEND_OR_FAMILY", PERSONALLY_KNOWN: "PERSONALLY_KNOWN",
    BUSINESS_OR_ORGANISATION: "BUSINESS_OR_ORGANISATION",
    INDIVIDUAL_NOT_PERSONALLY_KNOWN: "INDIVIDUAL_NOT_PERSONALLY_KNOWN",
    // Compatibility for stored v1.0/v1.1 snapshots.
    ONLINE_ONLY: "INDIVIDUAL_NOT_PERSONALLY_KNOWN",
    NOT_PERSONALLY_KNOWN: "INDIVIDUAL_NOT_PERSONALLY_KNOWN",
    KNOWN_PERSON: "PERSONALLY_KNOWN", KNOWN_BUSINESS: "BUSINESS_OR_ORGANISATION",
    NEW_RECIPIENT: "INDIVIDUAL_NOT_PERSONALLY_KNOWN",
  })[answers.beneficiary_relationship] ?? "UNCERTAIN";
  let paymentPurpose = PURPOSES[answers.payment_purpose] ?? "UNCERTAIN";
  if (/builder|renovation|kitchen|invoice/.test(lower)) paymentPurpose = "GOODS_OR_SERVICES";
  if (/safe account|keep (?:the |my )?money safe/.test(lower)) paymentPurpose = "SAFE_ACCOUNT";

  let thirdPartyInfluence = ({
    SELF_DECIDED: "SELF_DECIDED", RECIPIENT_INFLUENCED: "RECIPIENT_INFLUENCED",
    THIRD_PARTY_INFLUENCED: "THIRD_PARTY_INFLUENCED", DISCUSSION_ONLY: "DISCUSSION_ONLY",
    NO: "SELF_DECIDED", EXPECTED: "DISCUSSION_ONLY", UNEXPECTED: "THIRD_PARTY_INFLUENCED",
  })[answers.contact_influence] ?? "UNCERTAIN";
  if (/from (?:my|the) bank|bank (?:called|caller)|someone from.*bank/.test(lower)) {
    thirdPartyInfluence = "BANK_IMPERSONATION";
  }

  const verificationClaims = [];
  if (/met (?:him|her|them|the builder|the beneficiary)|in person/.test(lower)) {
    verificationClaims.push("MET_BENEFICIARY_IN_PERSON");
  }
  if (/checked (?:his|her|their|the) details|verified .*details/.test(lower)) {
    verificationClaims.push("CHECKED_BENEFICIARY_DETAILS");
  }
  if (/invoice/.test(lower)) verificationClaims.push("INVOICE_RECEIVED");

  const indicators = new Set();
  if (answers.contact_influence === "UNEXPECTED") indicators.add("UNEXPECTED_CONTACT");
  if (answers.pressure_or_secrecy === "YES") indicators.add("PRESSURE_OR_SECRECY");
  if (answers.remote_access === "YES") indicators.add("REMOTE_ACCESS");
  if (paymentPurpose === "SAFE_ACCOUNT") indicators.add("SAFE_ACCOUNT");
  if (paymentPurpose === "INVESTMENT") indicators.add("INVESTMENT");
  if (thirdPartyInfluence === "BANK_IMPERSONATION") indicators.add("BANK_IMPERSONATION");
  if (/urgent|urgently|immediately|right away|act quickly/.test(lower)) indicators.add("URGENCY");
  if (/friend(?:'s| of (?:him|her|theirs))? (?:account|bank)|friend can (?:take|withdraw)|(?:third[- ]party|unknown) (?:account|beneficiary)/.test(lower)) {
    indicators.add("THIRD_PARTY_BENEFICIARY");
  }
  if (indicators.size === 0) indicators.add("NONE");

  const provenance = [];
  const add = (findingId, claim, questionId) => {
    const excerpt = answers[questionId];
    if (excerpt) provenance.push({ findingId, claim, sources: [{ questionId, excerpt }] });
  };
  const narrativeQuestion = answers.investment_reason ? "investment_reason" : "payment_circumstances";
  add("paymentRecognition", `payment recognition is ${paymentRecognition}`, "payment_recognition");
  add("beneficiaryRelationship", `beneficiary relationship is ${beneficiaryRelationship}`,
    "beneficiary_relationship");
  add("paymentPurpose", `payment purpose is ${paymentPurpose}`,
    circumstances && paymentPurpose !== PURPOSES[answers.payment_purpose]
      ? narrativeQuestion : "payment_purpose");
  add("thirdPartyInfluence", `third-party influence is ${thirdPartyInfluence}`,
    thirdPartyInfluence === "BANK_IMPERSONATION"
      ? narrativeQuestion : "contact_influence");
  for (const claim of verificationClaims) {
    add(`verificationClaim:${claim}`, `customer states ${claim}`, narrativeQuestion);
  }
  for (const indicator of indicators) {
    if (indicator === "NONE") continue;
    const sourceQuestion = {
      UNEXPECTED_CONTACT: "contact_influence",
      PRESSURE_OR_SECRECY: "pressure_or_secrecy",
      REMOTE_ACCESS: "remote_access",
      SAFE_ACCOUNT: paymentPurpose === PURPOSES[answers.payment_purpose]
        ? "payment_purpose" : narrativeQuestion,
      INVESTMENT: "payment_purpose",
    }[indicator] ?? narrativeQuestion;
    add(`scamIndicator:${indicator}`, `indicator ${indicator}`, sourceQuestion);
  }

  const missingEvidence = context.requiredEvidenceKeys.filter((key) => !answers[key]);
  const uncertain = paymentRecognition === "UNCERTAIN"
    || beneficiaryRelationship === "UNCERTAIN"
    || paymentPurpose === "UNCERTAIN"
    || thirdPartyInfluence === "UNCERTAIN"
    || answers.pressure_or_secrecy === "UNSURE"
    || answers.remote_access === "UNSURE";
  return {
    schemaVersion: "fraud-intelligence-evidence/1.2.0",
    paymentRecognition,
    beneficiaryRelationship,
    paymentPurpose,
    thirdPartyInfluence,
    verificationClaims,
    scamIndicators: [...indicators],
    contradictions: [],
    uncertainty: missingEvidence.length > 0 ? "HIGH" : uncertain ? "MEDIUM" : "LOW",
    missingEvidence,
    provenance,
    clarificationQuestion: { needed: false, id: "", prompt: "", options: [], reason: "" },
  };
}
