export const GUIDANCE_CONTRACT_VERSION = "fraud-prevention-guidance/1.0.0";

const TEMPLATE_VERSION = "1.1.0";

const templates = {
  BANK_IMPERSONATION_SAFE_ACCOUNT: {
    templateId: "bank-impersonation-safe-account",
    heading: "Stop and check this payment",
    context: "Your answers describe unexpected bank contact or a request to move money to a ‘safe account’. A genuine bank will never ask you to move money to another account to keep it safe.",
    steps: [
      "End the call or conversation and do not use contact details they provided.",
      "Contact your bank using the trusted number in its official app, website or on your card.",
      "Do not make another payment until you have independently checked what happened.",
    ],
  },
  FAMILY_OR_TRUSTED_PERSON_IMPERSONATION: {
    templateId: "family-or-trusted-person-impersonation",
    heading: "We’d like to help you check this payment",
    context: "Your answers describe an unexpected, urgent request involving someone claiming to be a friend or family member. Scammers can impersonate people you trust, including by imitating a familiar voice.",
    steps: [
      "End the current call or conversation.",
      "Contact the person using a trusted number you already had, not one supplied in the request.",
      "Independently confirm the request before attempting another payment.",
    ],
  },
  UNEXPECTED_CONTACT_AND_PRESSURE: {
    templateId: "unexpected-contact-and-pressure",
    heading: "Take a moment to check this payment",
    context: "Your answers describe unexpected contact or pressure to act quickly. That can be a warning sign of an impersonation scam.",
    steps: [
      "Stop the conversation and do not follow any more instructions.",
      "Use a trusted contact method to check who contacted you and why.",
      "Do not try the payment again until the request has been independently confirmed.",
    ],
  },
  SERVICE_PAYMENT_ADDITIONAL_VERIFICATION: {
    templateId: "service-payment-independent-verification",
    heading: "Let’s independently verify the beneficiary",
    context: "You reported checks connected with a service payment. Those customer-reported checks are helpful, but they do not establish that the beneficiary account is safe.",
    steps: [
      "Contact the business using details you found independently, not only details on the invoice or message.",
      "Confirm the sort code and account number directly with the business using that trusted contact method.",
      "Wait for the independent beneficiary check before attempting another payment.",
    ],
  },
  HIGH_VALUE_FIRST_TIME_BENEFICIARY: {
    templateId: "high-value-first-time-beneficiary",
    heading: "Check this new beneficiary carefully",
    context: "This is a high-value payment to a beneficiary you have not paid before. A separate trusted check can help prevent money being sent to the wrong account.",
    steps: [
      "Contact the intended recipient using contact details you obtained independently.",
      "Confirm the account details and payment purpose without relying on the payment request alone.",
      "Do not attempt the payment again while anything remains uncertain.",
    ],
  },
  INVESTMENT_INDEPENDENT_CHECKS: {
    templateId: "investment-independent-checks",
    heading: "Check the investment independently",
    context: "You told us this payment is for an investment. That alone does not mean it is fraudulent or safe, and familiarity with the recipient or earlier payments does not verify the investment.",
    steps: [
      "Check the firm and investment using contact details and regulatory information you found independently.",
      "Confirm exactly what this payment funds, including any fees and how withdrawals are meant to work.",
      "Pause if anything you find independently differs from what you were told.",
    ],
  },
  UNCERTAIN_OR_INCOMPLETE: {
    templateId: "uncertain-or-incomplete-evidence",
    heading: "We need to check this payment further",
    context: "We could not safely personalise the advice from the available evidence. That does not mean the payment is safe.",
    steps: [
      "Pause and do not attempt the payment again yet.",
      "Independently check the person, business and account details using a trusted contact method.",
      "Return to the payment only after the request has been confirmed.",
    ],
  },
};

function provenanceFor(evidence, findingId) {
  if (!Array.isArray(evidence?.provenance)) return null;
  return evidence.provenance.find((item) => item?.findingId === findingId) ?? null;
}

function hasFinding(evidence, findingId) {
  return provenanceFor(evidence, findingId) !== null;
}

function hasIndicator(evidence, indicator) {
  return Array.isArray(evidence?.scamIndicators)
    && evidence.scamIndicators.includes(indicator)
    && hasFinding(evidence, `scamIndicator:${indicator}`);
}

function supportedFindingIds(evidence, candidates) {
  return [...new Set(candidates.filter((findingId) => hasFinding(evidence, findingId)))];
}

function evidenceDrivenFamilyGuidance(evidence, template) {
  const thirdPartyInstruction = hasIndicator(evidence, "THIRD_PARTY_BENEFICIARY");
  const reportedRisks = [
    hasIndicator(evidence, "UNEXPECTED_CONTACT") ? "the request came through unexpected contact" : null,
    hasIndicator(evidence, "URGENCY") || hasIndicator(evidence, "PRESSURE_OR_SECRECY")
      ? "you were asked to act urgently" : null,
    thirdPartyInstruction
      ? "you were directed to send money to another beneficiary" : null,
  ].filter(Boolean);
  const report = reportedRisks.length > 0
    ? `You told us that ${reportedRisks.join(", and ")}.`
    : "You told us this was a request for money involving someone you know.";
  return {
    ...template,
    context: `${report} We have not independently verified who contacted you or the circumstances they described. Criminals can impersonate someone you trust, and AI can make a voice sound familiar. This does not prove that impersonation or voice cloning happened, but it is safest to check the request another way.`,
    steps: [
      "End the current call or conversation.",
      "Contact the person using a number you already have saved, or another trusted way of reaching them.",
      thirdPartyInstruction
        ? "Do not send money to a friend’s or other third-party account until you have independently confirmed both the request and the account details."
        : "Do not send money until you have independently confirmed the request.",
    ],
  };
}

function evidenceDrivenServiceGuidance(evidence, template) {
  const reportedChecks = [
    evidence.verificationClaims?.includes("MET_BENEFICIARY_IN_PERSON") ? "met the beneficiary" : null,
    evidence.verificationClaims?.includes("CHECKED_BENEFICIARY_DETAILS") ? "checked their details" : null,
    evidence.verificationClaims?.includes("INVOICE_RECEIVED") ? "received an invoice" : null,
  ].filter(Boolean);
  if (reportedChecks.length === 0) return template;
  return {
    ...template,
    context: `You told us that you ${reportedChecks.join(", and ")}. These checks are based on your answers and have not been independently verified. They do not establish that the beneficiary account is safe.`,
  };
}

function renderTemplate(category, evidence, template) {
  if (category === "FAMILY_OR_TRUSTED_PERSON_IMPERSONATION") {
    return evidenceDrivenFamilyGuidance(evidence, template);
  }
  if (category === "SERVICE_PAYMENT_ADDITIONAL_VERIFICATION") {
    return evidenceDrivenServiceGuidance(evidence, template);
  }
  return template;
}

function selectCategory(evidence, reassessment, context) {
  const valid = ["fraud-intelligence-evidence/1.1.0", "fraud-intelligence-evidence/1.2.0"]
    .includes(evidence?.schemaVersion)
    && Array.isArray(evidence.provenance);
  if (!valid || (evidence.contradictions?.length ?? 0) > 0) {
    return { category: "UNCERTAIN_OR_INCOMPLETE", findingIds: [] };
  }

  const bankFindingIds = supportedFindingIds(evidence, [
    "scamIndicator:SAFE_ACCOUNT", "scamIndicator:BANK_IMPERSONATION", "thirdPartyInfluence",
  ]);
  if (hasIndicator(evidence, "SAFE_ACCOUNT") || hasIndicator(evidence, "BANK_IMPERSONATION")) {
    return { category: "BANK_IMPERSONATION_SAFE_ACCOUNT", findingIds: bankFindingIds };
  }

  const familySignals = ["UNEXPECTED_CONTACT", "URGENCY", "PRESSURE_OR_SECRECY"]
    .filter((indicator) => hasIndicator(evidence, indicator));
  if (evidence.paymentPurpose === "FRIENDS_OR_FAMILY" && hasFinding(evidence, "paymentPurpose")
      && familySignals.length > 0) {
    return {
      category: "FAMILY_OR_TRUSTED_PERSON_IMPERSONATION",
      findingIds: supportedFindingIds(evidence, [
        "paymentPurpose", ...familySignals.map((item) => `scamIndicator:${item}`),
        "scamIndicator:THIRD_PARTY_BENEFICIARY",
      ]),
    };
  }

  const pressureSignals = ["UNEXPECTED_CONTACT", "URGENCY", "PRESSURE_OR_SECRECY"]
    .filter((indicator) => hasIndicator(evidence, indicator));
  if (pressureSignals.length > 0) {
    return {
      category: "UNEXPECTED_CONTACT_AND_PRESSURE",
      findingIds: pressureSignals.map((item) => `scamIndicator:${item}`),
    };
  }

  if (evidence.uncertainty !== "LOW" || (evidence.missingEvidence?.length ?? 0) > 0) {
    return {
      category: "UNCERTAIN_OR_INCOMPLETE",
      findingIds: supportedFindingIds(evidence, [
        "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
      ]),
    };
  }

  if (reassessment?.outcome === "ADDITIONAL_VERIFICATION"
      && evidence.paymentPurpose === "GOODS_OR_SERVICES"
      && hasFinding(evidence, "paymentPurpose")) {
    return {
      category: "SERVICE_PAYMENT_ADDITIONAL_VERIFICATION",
      findingIds: supportedFindingIds(evidence, [
        "paymentPurpose", "beneficiaryRelationship", "verificationClaim:MET_BENEFICIARY_IN_PERSON",
        "verificationClaim:CHECKED_BENEFICIARY_DETAILS", "verificationClaim:INVOICE_RECEIVED",
      ]),
    };
  }

  if (evidence.paymentPurpose === "INVESTMENT" && hasFinding(evidence, "paymentPurpose")) {
    return {
      category: "INVESTMENT_INDEPENDENT_CHECKS",
      findingIds: supportedFindingIds(evidence, [
        "paymentPurpose", "beneficiaryRelationship", "thirdPartyInfluence",
      ]),
    };
  }

  if (context?.beneficiaryPreviouslyPaid === false && Number(context?.amount) >= 1_000
      && hasFinding(evidence, "beneficiaryRelationship")) {
    return {
      category: "HIGH_VALUE_FIRST_TIME_BENEFICIARY",
      findingIds: ["beneficiaryRelationship"],
    };
  }

  return {
    category: "UNCERTAIN_OR_INCOMPLETE",
    findingIds: supportedFindingIds(evidence, [
      "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
    ]),
  };
}

function paymentStatus(outcome) {
  if (outcome === "DECLINED") {
    return "We stopped this payment. No money was sent.";
  }
  if (outcome === "ADDITIONAL_VERIFICATION") {
    return "This payment needs independent verification. No money has been sent.";
  }
  return "This payment needs further review. No money has been sent.";
}

export function buildFraudPreventionGuidance({
  evidence,
  reassessment,
  customerExplanation = null,
  context = null,
}) {
  const selection = selectCategory(evidence, reassessment, context);
  const template = renderTemplate(selection.category, evidence, templates[selection.category]);
  const provenance = selection.findingIds
    .map((findingId) => provenanceFor(evidence, findingId))
    .filter(Boolean);
  return {
    contractVersion: GUIDANCE_CONTRACT_VERSION,
    category: selection.category,
    simulatedOutcome: reassessment?.outcome ?? "REFER_TO_ANALYST",
    personalised: selection.category !== "UNCERTAIN_OR_INCOMPLETE",
    customerStatement: typeof customerExplanation === "string" ? customerExplanation : null,
    evidenceFindingIds: selection.findingIds,
    evidenceProvenance: provenance,
    templateReferences: [{ templateId: template.templateId, version: TEMPLATE_VERSION }],
    rendered: {
      heading: reassessment?.outcome === "DECLINED"
        ? "We’ve stopped this payment to help keep your money safe" : template.heading,
      context: template.context,
      steps: template.steps,
      paymentStatus: paymentStatus(reassessment?.outcome),
      reviewMessage: "You can review the payment details in Glaramara.",
      simulationNotice: "This is a simulated payment. Your balance has not changed.",
    },
  };
}
