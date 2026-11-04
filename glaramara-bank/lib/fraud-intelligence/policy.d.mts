export const REASSESSMENT_POLICY_VERSION: "customer-evidence-reassessment/1.1.0";
export type ReassessmentOutcome = "ADDITIONAL_VERIFICATION" | "DECLINED" | "REFER_TO_ANALYST";
export type PolicyTrace = Array<{
  ruleId: string;
  policyVersion: string;
  outcome: ReassessmentOutcome;
  summary: string;
  conditions: Array<{ condition: string; actual: unknown; findingIds: string[] }>;
  sourceQuestionIds: string[];
}>;
export function reassessFraudEvidence(evidence: Record<string, unknown> | null): {
  outcome: ReassessmentOutcome;
  reasonCodes: string[];
  policyTrace: PolicyTrace;
};
