export const REASSESSMENT_POLICY_VERSION = "customer-evidence-reassessment/1.1.0";

const BUILDER_CLAIMS = [
  "MET_BENEFICIARY_IN_PERSON",
  "CHECKED_BENEFICIARY_DETAILS",
  "INVOICE_RECEIVED",
];

function sourceQuestionIds(evidence, findingIds) {
  return [...new Set((evidence?.provenance ?? [])
    .filter((item) => findingIds.includes(item.findingId))
    .flatMap((item) => Array.isArray(item.sources)
      ? item.sources.map((source) => source.questionId) : []))];
}

function result(evidence, ruleId, outcome, reasonCodes, summary, conditions) {
  const findingIds = conditions.flatMap((condition) => condition.findingIds);
  return {
    outcome,
    reasonCodes,
    policyTrace: [{
      ruleId,
      policyVersion: REASSESSMENT_POLICY_VERSION,
      outcome,
      summary,
      conditions,
      sourceQuestionIds: sourceQuestionIds(evidence, findingIds),
    }],
  };
}

export function reassessFraudEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== "fraud-intelligence-evidence/1.1.0") {
    return result(evidence, "CER-REFER-INVALID-EVIDENCE", "REFER_TO_ANALYST",
      ["INVALID_EVIDENCE_SCHEMA"], "Validated v1.1 evidence was unavailable.", [{
        condition: "schemaVersion must be fraud-intelligence-evidence/1.1.0",
        actual: evidence?.schemaVersion ?? "missing",
        findingIds: [],
      }]);
  }
  if (evidence.uncertainty !== "LOW" || evidence.contradictions.length > 0
      || evidence.missingEvidence.length > 0) {
    return result(evidence, "CER-REFER-UNRELIABLE-EVIDENCE", "REFER_TO_ANALYST",
      ["EVIDENCE_INCOMPLETE_OR_UNRELIABLE"],
      "The extraction was incomplete, uncertain, or contradictory.", [
        { condition: "uncertainty must be LOW", actual: evidence.uncertainty, findingIds: [] },
        { condition: "contradictions must be empty", actual: evidence.contradictions.length, findingIds: [] },
        { condition: "missingEvidence must be empty", actual: evidence.missingEvidence, findingIds: [] },
      ]);
  }
  if (evidence.paymentRecognition === "NOT_RECOGNISED") {
    return result(evidence, "CER-DECLINE-UNRECOGNISED", "DECLINED",
      ["CUSTOMER_DID_NOT_RECOGNISE_PAYMENT"],
      "The customer states that they did not make the payment.", [{
        condition: "paymentRecognition is NOT_RECOGNISED",
        actual: evidence.paymentRecognition,
        findingIds: ["paymentRecognition"],
      }]);
  }

  const indicator = (name) => evidence.scamIndicators.includes(name);
  const declineRules = [
    ["SAFE_ACCOUNT", "CER-DECLINE-SAFE-ACCOUNT", "SCAM_PATTERN_SAFE_ACCOUNT",
      "The evidence contains a safe-account transfer instruction."],
    ["BANK_IMPERSONATION", "CER-DECLINE-BANK-IMPERSONATION", "SCAM_PATTERN_BANK_IMPERSONATION",
      "The evidence contains claimed bank contact directing the payment."],
    ["REMOTE_ACCESS", "CER-DECLINE-REMOTE-ACCESS", "SCAM_PATTERN_REMOTE_ACCESS",
      "The evidence contains a remote-access request."],
    ["PRESSURE_OR_SECRECY", "CER-DECLINE-PRESSURE-SECRECY",
      "SCAM_PATTERN_PRESSURE_OR_SECRECY",
      "The evidence contains explicit pressure, secrecy, or warning avoidance."],
  ];
  for (const [indicatorName, ruleId, reasonCode, summary] of declineRules) {
    if (indicator(indicatorName)) {
      return result(evidence, ruleId, "DECLINED", [reasonCode], summary, [{
        condition: `scamIndicators contains ${indicatorName}`,
        actual: evidence.scamIndicators,
        findingIds: [`scamIndicator:${indicatorName}`],
      }]);
    }
  }
  if (indicator("THIRD_PARTY_BENEFICIARY") && indicator("UNEXPECTED_CONTACT")) {
    return result(evidence, "CER-DECLINE-UNEXPECTED-THIRD-PARTY", "DECLINED",
      ["SCAM_PATTERN_UNEXPECTED_THIRD_PARTY_BENEFICIARY"],
      "Unexpected contact directed the customer to a third-party beneficiary.", [{
        condition: "unexpected contact and a third-party beneficiary are both present",
        actual: evidence.scamIndicators,
        findingIds: [
          "scamIndicator:UNEXPECTED_CONTACT", "scamIndicator:THIRD_PARTY_BENEFICIARY",
        ],
      }]);
  }

  const hasAllBuilderClaims = BUILDER_CLAIMS.every(
    (claim) => evidence.verificationClaims.includes(claim),
  );
  const noScamIndicators = evidence.scamIndicators.length === 1
    && evidence.scamIndicators[0] === "NONE";
  const acceptableInfluence = ["NONE", "EXPECTED"].includes(evidence.thirdPartyInfluence);
  if (evidence.paymentRecognition === "RECOGNISED"
      && evidence.beneficiaryRelationship === "NEW"
      && evidence.paymentPurpose === "GOODS_OR_SERVICES"
      && hasAllBuilderClaims && acceptableInfluence && noScamIndicators) {
    return result(
      evidence,
      "CER-ADDITIONAL-VERIFY-NARROW-SERVICE-PAYMENT",
      "ADDITIONAL_VERIFICATION",
      ["NARROW_SERVICE_PAYMENT_REQUIRES_INDEPENDENT_BENEFICIARY_VERIFICATION"],
      "Customer-stated service-payment evidence is reassuring but does not establish safety; independent beneficiary verification remains mandatory.",
      [
        {
          condition: "payment is recognised",
          actual: evidence.paymentRecognition,
          findingIds: ["paymentRecognition"],
        },
        {
          condition: "beneficiary is new",
          actual: evidence.beneficiaryRelationship,
          findingIds: ["beneficiaryRelationship"],
        },
        {
          condition: "purpose is goods or services",
          actual: evidence.paymentPurpose,
          findingIds: ["paymentPurpose"],
        },
        {
          condition: "all narrow demonstration verification claims are present",
          actual: evidence.verificationClaims,
          findingIds: BUILDER_CLAIMS.map((claim) => `verificationClaim:${claim}`),
        },
        {
          condition: "influence is none or expected",
          actual: evidence.thirdPartyInfluence,
          findingIds: ["thirdPartyInfluence"],
        },
        {
          condition: "no scam indicator was extracted",
          actual: evidence.scamIndicators,
          findingIds: [],
        },
      ],
    );
  }

  return result(evidence, "CER-REFER-NO-SAFE-INFERENCE", "REFER_TO_ANALYST",
    ["EVIDENCE_DOES_NOT_SATISFY_A_DETERMINISTIC_ACTION_RULE"],
    "No high-risk decline rule or narrow additional-verification rule fully matched; safety is not inferred from absence.",
    [{
      condition: "a complete deterministic action rule must match",
      actual: "no complete rule matched",
      findingIds: [
        "paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
      ],
    }]);
}
