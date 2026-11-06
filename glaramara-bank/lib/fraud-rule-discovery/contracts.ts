import { createHash } from "node:crypto";

import { z } from "zod";

export const PROPOSAL_SCHEMA_VERSION = "fraud-rule-proposal/1.0.0";
export const REPORT_SCHEMA_VERSION = "fraud-discovery-report/1.0.0";

export const featureCatalogue = [
  { id: "amount_gbp", windows: [null], description: "Current payment amount in GBP" },
  { id: "beneficiary_payment_count_before", windows: [null], description: "Prior customer payments to beneficiary" },
  { id: "customer_transaction_count", windows: ["PT1M", "PT2M", "PT10M", "PT24H"], description: "Customer payment count" },
  { id: "customer_total_amount_gbp", windows: ["PT2M", "PT24H"], description: "Customer payment total" },
  { id: "customer_distinct_merchant_count", windows: ["PT2M"], description: "Distinct customer merchants" },
  { id: "customer_distinct_new_beneficiary_count", windows: ["PT24H"], description: "Distinct newly paid beneficiaries" },
  { id: "customer_new_beneficiary_payment_count", windows: ["PT24H"], description: "Payments to newly paid beneficiaries" },
  { id: "customer_new_beneficiary_total_gbp", windows: ["PT24H"], description: "Total sent to newly paid beneficiaries" },
  { id: "beneficiary_distinct_customers", windows: ["PT24H"], description: "Distinct customers paying this beneficiary" },
] as const;

const featureIds = featureCatalogue.map((feature) => feature.id) as [string, ...string[]];
const windows = ["PT1M", "PT2M", "PT10M", "PT24H"] as const;

export const ruleConditionSchema = z.object({
  featureId: z.enum(featureIds),
  operator: z.enum(["GT", "GTE", "LT", "LTE", "EQ"]),
  threshold: z.number().finite().min(0).max(10_000_000),
  window: z.enum(windows).nullable(),
}).strict().superRefine((condition, context) => {
  const feature = featureCatalogue.find((item) => item.id === condition.featureId);
  if (!feature || !(feature.windows as readonly (string | null)[]).includes(condition.window)) {
    context.addIssue({ code: "custom", path: ["window"], message: "Window is unsupported for feature" });
  }
});

export const fraudRuleProposalSchema = z.object({
  schemaVersion: z.literal(PROPOSAL_SCHEMA_VERSION),
  ruleIdentifier: z.string().regex(/^FRD-[A-Z0-9-]{3,64}$/),
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().min(10).max(600),
  rationale: z.string().trim().min(10).max(1_200),
  logicalOperator: z.literal("ALL"),
  conditions: z.array(ruleConditionSchema).min(1).max(5),
  action: z.literal("CHALLENGED"),
  supportingEvidenceRefs: z.array(z.string().min(1).max(120)).min(1).max(12),
  limitations: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
  agentVersion: z.literal("1.0.0"),
}).strict().superRefine((proposal, context) => {
  const keys = proposal.conditions.map((condition) => JSON.stringify(condition));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["conditions"], message: "Conditions must be unique" });
  }
});

export type FraudRuleProposal = z.infer<typeof fraudRuleProposalSchema>;
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export class FraudRuleDiscoveryEvidenceReferenceError extends Error {
  readonly invalidReferences: string[];
  readonly allowedReferenceCount: number;

  constructor(invalidReferences: string[], allowedReferenceCount: number) {
    super("proposal contains an evidence reference outside the discovery report");
    this.name = "FraudRuleDiscoveryEvidenceReferenceError";
    this.invalidReferences = invalidReferences;
    this.allowedReferenceCount = allowedReferenceCount;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function ruleFingerprint(proposal: FraudRuleProposal): string {
  const conditions = [...proposal.conditions].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return sha256({ action: proposal.action, logicalOperator: proposal.logicalOperator, conditions });
}

export function validateEvidenceReferences(proposal: FraudRuleProposal, report: { cohorts: Array<{ evidenceRef: string }>; examples: Array<{ evidenceRef: string }> }): void {
  const allowed = new Set([...report.cohorts, ...report.examples].map((item) => item.evidenceRef));
  const invalidReferences = proposal.supportingEvidenceRefs.filter((reference) => !allowed.has(reference));
  if (invalidReferences.length) throw new FraudRuleDiscoveryEvidenceReferenceError(invalidReferences, allowed.size);
}

