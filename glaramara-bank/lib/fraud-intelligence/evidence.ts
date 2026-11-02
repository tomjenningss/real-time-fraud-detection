import { z } from "zod";

import { buildMockEvidence } from "@/lib/fraud-intelligence/mock-evidence.mjs";

export const EVIDENCE_SCHEMA_VERSION = "fraud-intelligence-evidence/1.0.0";

const sourceIds = z.array(z.string().min(1).max(96)).min(1).max(6);

export const fraudEvidenceSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  paymentRecognition: z.enum(["RECOGNISED", "NOT_RECOGNISED", "UNCERTAIN"]),
  beneficiaryRelationship: z.enum(["KNOWN", "NEW", "UNCERTAIN"]),
  scamIndicators: z.array(z.enum([
    "UNEXPECTED_CONTACT",
    "PRESSURE_OR_SECRECY",
    "SAFE_ACCOUNT",
    "IMPERSONATION",
    "INVESTMENT",
    "REMOTE_ACCESS",
    "NONE",
  ])).min(1).max(8),
  contradictions: z.array(z.object({
    summary: z.string().min(1).max(240),
    sourceQuestionIds: sourceIds,
  })).max(6),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
  missingEvidence: z.array(z.string().min(1).max(96)).max(8),
  provenance: z.array(z.object({
    claim: z.string().min(1).max(240),
    sourceQuestionIds: sourceIds,
  })).min(1).max(16),
  clarificationQuestion: z.object({
    needed: z.boolean(),
    id: z.string().max(80),
    prompt: z.string().max(200),
    options: z.array(z.string().min(1).max(80)).max(4),
    reason: z.string().max(160),
  }),
}).strict().superRefine((value, context) => {
  if (new Set(value.scamIndicators).size !== value.scamIndicators.length) {
    context.addIssue({ code: "custom", path: ["scamIndicators"], message: "Indicators must be unique" });
  }
  if (value.scamIndicators.includes("NONE") && value.scamIndicators.length > 1) {
    context.addIssue({ code: "custom", path: ["scamIndicators"], message: "NONE is exclusive" });
  }
  const hasSource = (questionId: string) => value.provenance.some(
    (item) => item.sourceQuestionIds.includes(questionId),
  );
  for (const questionId of ["payment_recognition", "beneficiary_relationship"]) {
    if (!hasSource(questionId)) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: `Provenance must support ${questionId}`,
      });
    }
  }
  const indicatorSources: Partial<Record<(typeof value.scamIndicators)[number], string>> = {
    UNEXPECTED_CONTACT: "contact_influence",
    PRESSURE_OR_SECRECY: "pressure_or_secrecy",
    SAFE_ACCOUNT: "payment_purpose",
    IMPERSONATION: "contact_influence",
    INVESTMENT: "payment_purpose",
    REMOTE_ACCESS: "remote_access",
  };
  for (const indicator of value.scamIndicators) {
    const questionId = indicatorSources[indicator];
    if (questionId && !hasSource(questionId)) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: `Provenance must support ${indicator}`,
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

export function mockedEvidence(context: MinimalInvestigationContext): FraudEvidence {
  return fraudEvidenceSchema.parse(buildMockEvidence(context));
}
