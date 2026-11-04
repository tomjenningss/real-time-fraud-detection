const PURPOSES = {
  GOODS_SERVICES: "GOODS_OR_SERVICES",
  FRIENDS_FAMILY: "FRIENDS_OR_FAMILY",
  INVESTMENT: "INVESTMENT",
  SAFE_ACCOUNT: "SAFE_ACCOUNT",
  OTHER: "OTHER",
};

export function buildMockEvidence(context) {
  const answers = Object.fromEntries(context.answers.map((answer) => [answer.questionId, answer.value]));
  const circumstances = answers.payment_circumstances ?? answers.other_purpose ?? "";
  const lower = circumstances.toLowerCase();
  const paymentRecognition = answers.payment_recognition === "YES"
    ? "RECOGNISED"
    : answers.payment_recognition === "NO" ? "NOT_RECOGNISED" : "UNCERTAIN";
  const beneficiaryRelationship = ["KNOWN_PERSON", "KNOWN_BUSINESS"].includes(
    answers.beneficiary_relationship,
  )
    ? "KNOWN"
    : answers.beneficiary_relationship === "NEW_RECIPIENT" ? "NEW" : "UNCERTAIN";
  let paymentPurpose = PURPOSES[answers.payment_purpose] ?? "UNCERTAIN";
  if (/builder|renovation|kitchen|invoice/.test(lower)) paymentPurpose = "GOODS_OR_SERVICES";
  if (/safe account|keep (?:the |my )?money safe/.test(lower)) paymentPurpose = "SAFE_ACCOUNT";

  let thirdPartyInfluence = answers.contact_influence === "NO" ? "NONE"
    : answers.contact_influence === "EXPECTED" ? "EXPECTED"
      : answers.contact_influence === "UNEXPECTED" ? "UNEXPECTED" : "UNCERTAIN";
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
  add("paymentRecognition", `payment recognition is ${paymentRecognition}`, "payment_recognition");
  add("beneficiaryRelationship", `beneficiary relationship is ${beneficiaryRelationship}`,
    "beneficiary_relationship");
  add("paymentPurpose", `payment purpose is ${paymentPurpose}`,
    circumstances && paymentPurpose !== PURPOSES[answers.payment_purpose]
      ? "payment_circumstances" : "payment_purpose");
  add("thirdPartyInfluence", `third-party influence is ${thirdPartyInfluence}`,
    thirdPartyInfluence === "BANK_IMPERSONATION" ? "payment_circumstances" : "contact_influence");
  for (const claim of verificationClaims) {
    add(`verificationClaim:${claim}`, `customer states ${claim}`, "payment_circumstances");
  }
  for (const indicator of indicators) {
    if (indicator === "NONE") continue;
    const sourceQuestion = {
      UNEXPECTED_CONTACT: "contact_influence",
      PRESSURE_OR_SECRECY: "pressure_or_secrecy",
      REMOTE_ACCESS: "remote_access",
      SAFE_ACCOUNT: paymentPurpose === PURPOSES[answers.payment_purpose]
        ? "payment_purpose" : "payment_circumstances",
      INVESTMENT: "payment_purpose",
    }[indicator] ?? "payment_circumstances";
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
    schemaVersion: "fraud-intelligence-evidence/1.1.0",
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
