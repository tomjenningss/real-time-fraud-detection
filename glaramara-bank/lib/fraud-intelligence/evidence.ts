import { z } from "zod";

import { buildMockEvidence } from "@/lib/fraud-intelligence/mock-evidence.mjs";

export const EVIDENCE_SCHEMA_VERSION = "fraud-intelligence-evidence/1.1.0";

const questionId = z.string().min(1).max(96);
const source = z.object({
  questionId,
  excerpt: z.string().min(1).max(500),
}).strict();

export const fraudEvidenceSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  paymentRecognition: z.enum(["RECOGNISED", "NOT_RECOGNISED", "UNCERTAIN"]),
  beneficiaryRelationship: z.enum(["KNOWN", "NEW", "UNCERTAIN"]),
  paymentPurpose: z.enum([
    "GOODS_OR_SERVICES", "FRIENDS_OR_FAMILY", "INVESTMENT", "SAFE_ACCOUNT", "OTHER", "UNCERTAIN",
  ]),
  thirdPartyInfluence: z.enum([
    "NONE", "EXPECTED", "UNEXPECTED", "BANK_IMPERSONATION", "UNCERTAIN",
  ]),
  verificationClaims: z.array(z.enum([
    "MET_BENEFICIARY_IN_PERSON", "CHECKED_BENEFICIARY_DETAILS", "INVOICE_RECEIVED",
  ])).max(3),
  scamIndicators: z.array(z.enum([
    "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "URGENCY", "SAFE_ACCOUNT",
    "BANK_IMPERSONATION", "THIRD_PARTY_BENEFICIARY", "INVESTMENT", "REMOTE_ACCESS", "NONE",
  ])).min(1).max(9),
  contradictions: z.array(z.object({
    summary: z.string().min(1).max(240),
    sourceQuestionIds: z.array(questionId).min(1).max(6),
  }).strict()).max(6),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
  missingEvidence: z.array(questionId).max(8),
  provenance: z.array(z.object({
    findingId: z.string().min(1).max(96),
    claim: z.string().min(1).max(240),
    sources: z.array(source).min(1).max(6),
  }).strict()).min(4).max(24),
  clarificationQuestion: z.object({
    needed: z.boolean(),
    id: z.string().max(80),
    prompt: z.string().max(200),
    options: z.array(z.string().min(1).max(80)).max(4),
    reason: z.string().max(160),
  }).strict(),
}).strict().superRefine((value, context) => {
  for (const [path, values] of [
    ["verificationClaims", value.verificationClaims],
    ["scamIndicators", value.scamIndicators],
    ["missingEvidence", value.missingEvidence],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", path: [path], message: `${path} values must be unique` });
    }
  }
  if (value.scamIndicators.includes("NONE") && value.scamIndicators.length > 1) {
    context.addIssue({ code: "custom", path: ["scamIndicators"], message: "NONE is exclusive" });
  }
  const findingIds = new Set(value.provenance.map((item) => item.findingId));
  if (findingIds.size !== value.provenance.length) {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "Each findingId may appear only once",
    });
  }
  const requiredFindingIds = [
    "paymentRecognition",
    "beneficiaryRelationship",
    "paymentPurpose",
    "thirdPartyInfluence",
    ...value.verificationClaims.map((item) => `verificationClaim:${item}`),
    ...value.scamIndicators.filter((item) => item !== "NONE").map((item) => `scamIndicator:${item}`),
  ];
  for (const findingId of requiredFindingIds) {
    if (!findingIds.has(findingId)) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: `Provenance must support ${findingId}`,
      });
    }
  }
  const allowedSources = (findingId: string): Set<string> => {
    const fixed: Record<string, string[]> = {
      paymentRecognition: ["payment_recognition"],
      beneficiaryRelationship: ["beneficiary_relationship"],
      paymentPurpose: ["payment_purpose", "payment_circumstances", "other_purpose"],
      thirdPartyInfluence: ["contact_influence", "payment_circumstances"],
      "scamIndicator:UNEXPECTED_CONTACT": ["contact_influence", "payment_circumstances"],
      "scamIndicator:PRESSURE_OR_SECRECY": ["pressure_or_secrecy", "payment_circumstances"],
      "scamIndicator:URGENCY": ["payment_circumstances", "pressure_or_secrecy"],
      "scamIndicator:SAFE_ACCOUNT": ["payment_purpose", "payment_circumstances"],
      "scamIndicator:BANK_IMPERSONATION": ["payment_circumstances", "contact_influence"],
      "scamIndicator:THIRD_PARTY_BENEFICIARY": ["payment_circumstances"],
      "scamIndicator:INVESTMENT": ["payment_purpose", "payment_circumstances"],
      "scamIndicator:REMOTE_ACCESS": ["remote_access", "payment_circumstances"],
      "scamIndicator:NONE": ["contact_influence", "payment_circumstances"],
    };
    if (findingId.startsWith("verificationClaim:")) {
      return new Set(["payment_circumstances", "other_purpose"]);
    }
    return new Set(fixed[findingId] ?? []);
  };
  for (const item of value.provenance) {
    const allowed = allowedSources(item.findingId);
    if (allowed.size === 0 || item.sources.some((itemSource) => !allowed.has(itemSource.questionId))) {
      context.addIssue({
        code: "custom",
        path: ["provenance", item.findingId],
        message: `Finding ${item.findingId} cites an unsupported question`,
      });
    }
  }
  const clarification = value.clarificationQuestion;
  if (clarification.needed) {
    if (!/^clarification_[a-z0-9_]{1,64}$/.test(clarification.id)
        || !clarification.prompt || clarification.options.length < 2 || !clarification.reason) {
      context.addIssue({
        code: "custom",
        path: ["clarificationQuestion"],
        message: "A needed clarification must contain a valid id, prompt, options and reason",
      });
    }
  } else if (clarification.id || clarification.prompt || clarification.options.length || clarification.reason) {
    context.addIssue({
      code: "custom",
      path: ["clarificationQuestion"],
      message: "An unused clarification must contain only empty values",
    });
  }
});

export type FraudEvidence = z.infer<typeof fraudEvidenceSchema>;

export type MinimalInvestigationContext = {
  schemaVersion: "fraud-intelligence-request/1.0.0";
  questionnaireVersion: string;
  transactionRef: string;
  payment: { amount: number; currency: "GBP"; beneficiaryPreviouslyPaid: boolean };
  deterministicSignals: string[];
  requiredEvidenceKeys: string[];
  questions: Array<{ id: string; prompt: string; options?: string[] }>;
  answers: Array<{ questionId: string; value: string; provenance: "CUSTOMER" }>;
};

export function validateFraudEvidence(
  candidate: unknown,
  context: MinimalInvestigationContext,
): FraudEvidence {
  const evidence = fraudEvidenceSchema.parse(candidate);
  const answers = new Map(context.answers.map((answer) => [answer.questionId, answer.value]));
  const invariantIssues: Array<{ path: PropertyKey[]; message: string }> = [];
  const requireValue = (
    questionId: string,
    field: keyof FraudEvidence,
    allowedValues: readonly unknown[],
  ): void => {
    const answer = answers.get(questionId);
    if (answer !== undefined && !allowedValues.includes(evidence[field])) {
      invariantIssues.push({
        path: [field],
        message: `${field} violates the bounded ${questionId}=${answer} mapping`,
      });
    }
  };
  const requireIndicator = (
    questionId: string,
    answerValue: string,
    indicator: FraudEvidence["scamIndicators"][number],
  ): void => {
    if (answers.get(questionId) === answerValue && !evidence.scamIndicators.includes(indicator)) {
      invariantIssues.push({
        path: ["scamIndicators"],
        message: `${questionId}=${answerValue} requires ${indicator}`,
      });
    }
  };

  const paymentRecognitionMappings: Record<string, FraudEvidence["paymentRecognition"]> = {
    YES: "RECOGNISED", NO: "NOT_RECOGNISED", UNSURE: "UNCERTAIN",
  };
  const beneficiaryMappings: Record<string, FraudEvidence["beneficiaryRelationship"]> = {
    KNOWN_PERSON: "KNOWN", KNOWN_BUSINESS: "KNOWN", NEW_RECIPIENT: "NEW", UNSURE: "UNCERTAIN",
  };
  const purposeMappings: Record<string, readonly FraudEvidence["paymentPurpose"][]> = {
    GOODS_SERVICES: ["GOODS_OR_SERVICES"],
    FRIENDS_FAMILY: ["FRIENDS_OR_FAMILY"],
    INVESTMENT: ["INVESTMENT"],
    SAFE_ACCOUNT: ["SAFE_ACCOUNT"],
    OTHER: ["OTHER", "GOODS_OR_SERVICES"],
  };
  const influenceMappings: Record<string, readonly FraudEvidence["thirdPartyInfluence"][]> = {
    NO: ["NONE"], EXPECTED: ["EXPECTED"], UNEXPECTED: ["UNEXPECTED", "BANK_IMPERSONATION"],
  };
  const recognitionAnswer = answers.get("payment_recognition");
  const beneficiaryAnswer = answers.get("beneficiary_relationship");
  const purposeAnswer = answers.get("payment_purpose");
  const influenceAnswer = answers.get("contact_influence");
  if (typeof recognitionAnswer === "string" && recognitionAnswer in paymentRecognitionMappings) {
    requireValue("payment_recognition", "paymentRecognition", [paymentRecognitionMappings[recognitionAnswer]]);
  }
  if (typeof beneficiaryAnswer === "string" && beneficiaryAnswer in beneficiaryMappings) {
    requireValue("beneficiary_relationship", "beneficiaryRelationship", [beneficiaryMappings[beneficiaryAnswer]]);
  }
  if (typeof purposeAnswer === "string" && purposeAnswer in purposeMappings) {
    requireValue("payment_purpose", "paymentPurpose", purposeMappings[purposeAnswer]);
  }
  if (typeof influenceAnswer === "string" && influenceAnswer in influenceMappings) {
    requireValue("contact_influence", "thirdPartyInfluence", influenceMappings[influenceAnswer]);
  }

  requireIndicator("payment_purpose", "INVESTMENT", "INVESTMENT");
  requireIndicator("payment_purpose", "SAFE_ACCOUNT", "SAFE_ACCOUNT");
  requireIndicator("contact_influence", "UNEXPECTED", "UNEXPECTED_CONTACT");
  requireIndicator("pressure_or_secrecy", "YES", "PRESSURE_OR_SECRECY");
  requireIndicator("remote_access", "YES", "REMOTE_ACCESS");
  if (evidence.paymentPurpose === "INVESTMENT" && !evidence.scamIndicators.includes("INVESTMENT")) {
    invariantIssues.push({
      path: ["scamIndicators"],
      message: "paymentPurpose=INVESTMENT requires INVESTMENT",
    });
  }
  const missingRequiredEvidence = evidence.missingEvidence.some(
    (questionId) => context.requiredEvidenceKeys.includes(questionId),
  );
  if (missingRequiredEvidence && evidence.uncertainty !== "HIGH") {
    invariantIssues.push({
      path: ["uncertainty"],
      message: "Missing required evidence requires HIGH uncertainty",
    });
  } else if (([...answers.values()].includes("UNSURE") || evidence.contradictions.length > 0)
      && evidence.uncertainty !== "MEDIUM") {
    invariantIssues.push({
      path: ["uncertainty"],
      message: "Supplied uncertainty or contradictions require MEDIUM uncertainty",
    });
  }
  if (invariantIssues.length > 0) {
    throw new z.ZodError(invariantIssues.map((issue) => ({ code: "custom" as const, ...issue })));
  }
  for (const item of evidence.provenance) {
    for (const cited of item.sources) {
      const answer = answers.get(cited.questionId);
      if (!answer || !answer.includes(cited.excerpt)) {
        throw new z.ZodError([{
          code: "custom",
          path: ["provenance", item.findingId, "sources"],
          message: `Provenance excerpt is not present in ${cited.questionId}`,
        }]);
      }
    }
  }
  return evidence;
}

export function mockedEvidence(context: MinimalInvestigationContext): FraudEvidence {
  return validateFraudEvidence(buildMockEvidence(context), context);
}
