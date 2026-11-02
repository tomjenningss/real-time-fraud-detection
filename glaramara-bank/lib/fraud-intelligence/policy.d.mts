export const REASSESSMENT_POLICY_VERSION: "customer-evidence-reassessment/1.0.0";
export type ReassessmentOutcome = "CLEARED" | "REQUIRES_FURTHER_REVIEW" | "DECLINED";
export function reassessFraudEvidence(evidence: {
  schemaVersion: string;
  paymentRecognition: string;
  beneficiaryRelationship: string;
  scamIndicators: string[];
  uncertainty: string;
  contradictions: unknown[];
  missingEvidence: string[];
} | null): { outcome: ReassessmentOutcome; reasonCodes: string[] };
