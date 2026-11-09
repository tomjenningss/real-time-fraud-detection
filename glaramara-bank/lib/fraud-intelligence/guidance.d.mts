export const GUIDANCE_CONTRACT_VERSION: "fraud-prevention-guidance/1.0.0";

export type FraudPreventionGuidance = {
  contractVersion: typeof GUIDANCE_CONTRACT_VERSION;
  category: "BANK_IMPERSONATION_SAFE_ACCOUNT"
    | "FAMILY_OR_TRUSTED_PERSON_IMPERSONATION"
    | "UNEXPECTED_CONTACT_AND_PRESSURE"
    | "SERVICE_PAYMENT_ADDITIONAL_VERIFICATION"
    | "INVESTMENT_INDEPENDENT_CHECKS"
    | "HIGH_VALUE_FIRST_TIME_BENEFICIARY"
    | "UNCERTAIN_OR_INCOMPLETE";
  simulatedOutcome: string;
  personalised: boolean;
  customerStatement: string | null;
  evidenceFindingIds: string[];
  evidenceProvenance: unknown[];
  templateReferences: Array<{ templateId: string; version: string }>;
  rendered: {
    heading: string;
    context: string;
    steps: string[];
    paymentStatus: string;
    reviewMessage: string;
    simulationNotice: string;
  };
};

export function buildFraudPreventionGuidance(input: {
  evidence: unknown;
  reassessment: { outcome: string } | null;
  customerExplanation?: string | null;
  context?: {
    amount: number;
    beneficiaryPreviouslyPaid: boolean;
    deterministicSignals?: string[];
    slowBuildingEvidence?: {
      payments30d: number;
      cumulativeAmount30d: number;
      successiveGrowthCount: number;
      currentToFirstAmountRatio: number;
      observedRelationshipAgeDays: number;
    };
  } | null;
}): FraudPreventionGuidance;
