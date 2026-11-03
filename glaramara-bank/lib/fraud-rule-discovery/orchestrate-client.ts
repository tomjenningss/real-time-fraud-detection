import "server-only";

import type { FraudRuleProposal } from "@/lib/fraud-rule-discovery/contracts";
import { fraudRuleProposalSchema } from "@/lib/fraud-rule-discovery/contracts";
import { IbmIamTokenProvider, withOneIamRetry } from "@/lib/fraud-intelligence/ibm-iam";

const tokenProvider = new IbmIamTokenProvider();

function integrationError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function validateProposal(value: unknown): FraudRuleProposal {
  const parsed = fraudRuleProposalSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "proposal"))]
    .slice(0, 6).join(",");
  throw integrationError(
    "FraudRuleDiscoveryInvalidProposalError",
    `Fraud Rule Discovery proposal failed strict validation at: ${paths}`,
  );
}

function baseUrl(): string {
  const configured = process.env.WATSONX_ORCHESTRATE_URL?.trim();
  if (!configured) throw new Error("WATSONX_ORCHESTRATE_URL is required for rule discovery");
  const url = new URL(configured);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".watson-orchestrate.cloud.ibm.com")
      || !/^\/instances\/[0-9a-f-]{36}\/?$/i.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error("WATSONX_ORCHESTRATE_URL is not a supported IBM Cloud service instance URL");
  }
  return url.toString().replace(/\/$/, "");
}

function findProposal(value: unknown): unknown | undefined {
  if (typeof value === "string") {
    const candidate = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return findProposal(JSON.parse(candidate)); }
    catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return findProposal(JSON.parse(candidate.slice(start, end + 1))); }
        catch { return undefined; }
      }
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findProposal(item); if (found !== undefined) return found; }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.schemaVersion === "fraud-rule-proposal/1.0.0"
        || (typeof record.ruleIdentifier === "string" && Array.isArray(record.conditions))) return record;
    for (const item of Object.values(record)) { const found = findProposal(item); if (found !== undefined) return found; }
  }
  return undefined;
}

function mockProposal(report: { cohorts: Array<{ evidenceRef: string }> }): FraudRuleProposal {
  const evidenceRef = report.cohorts.find((item) => item.evidenceRef.includes("distinct_new_beneficiaries"))?.evidenceRef
    ?? report.cohorts[0]?.evidenceRef ?? "cohort:unavailable";
  return fraudRuleProposalSchema.parse({
    schemaVersion: "fraud-rule-proposal/1.0.0",
    ruleIdentifier: "FRD-MULTI-NEW-BENEFICIARY-24H",
    name: "Multiple new beneficiaries in 24 hours",
    description: "Challenge customers paying several previously unseen beneficiaries during one day.",
    rationale: "Discovery evidence shows fraud-labelled baseline misses concentrated in this bounded behaviour.",
    logicalOperator: "ALL",
    conditions: [
      { featureId: "customer_distinct_new_beneficiary_count", operator: "GTE", threshold: 4, window: "PT24H" },
      { featureId: "customer_new_beneficiary_total_gbp", operator: "GTE", threshold: 1_500, window: "PT24H" },
    ],
    action: "CHALLENGED",
    supportingEvidenceRefs: [evidenceRef],
    limitations: ["Legitimate customers making several first-time payments may be challenged."],
    uncertainty: "MEDIUM",
    agentVersion: "1.0.0",
  });
}

export async function discoverRule(report: unknown): Promise<{ proposal: FraudRuleProposal; provider: string; model: string; agentId: string; latencyMs: number }> {
  const provider = process.env.FRAUD_RULE_DISCOVERY_PROVIDER?.trim() || "disabled";
  const started = performance.now();
  if (provider === "mock") {
    return {
      proposal: mockProposal(report as { cohorts: Array<{ evidenceRef: string }> }),
      provider: "deterministic-fixture",
      model: "mock-fraud-rule-discovery/1.0.0",
      agentId: "mock-fraud-rule-discovery",
      latencyMs: Math.round(performance.now() - started),
    };
  }
  if (provider !== "orchestrate") throw new Error("Fraud Rule Discovery execution is disabled");
  const agentId = process.env.FRAUD_RULE_DISCOVERY_AGENT_ID?.trim();
  if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) throw new Error("FRAUD_RULE_DISCOVERY_AGENT_ID is required");
  const response = await withOneIamRetry(tokenProvider, (accessToken) => fetch(
    `${baseUrl()}/v1/orchestrate/${agentId}/chat/completions`,
    {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify(report) }], stream: false }),
      signal: AbortSignal.timeout(Number(process.env.FRAUD_RULE_DISCOVERY_TIMEOUT_MS ?? "60000")),
    },
  ));
  if (!response.ok) throw integrationError(
    "FraudRuleDiscoveryHttpError",
    `Fraud Rule Discovery REST request failed with status ${response.status}`,
  );
  const found = findProposal(await response.json());
  if (found === undefined) throw integrationError(
    "FraudRuleDiscoveryProposalNotFoundError",
    "Fraud Rule Discovery response contained no schema-versioned proposal",
  );
  return {
    proposal: validateProposal(found),
    provider: "watsonx-orchestrate-rest",
    model: process.env.FRAUD_RULE_DISCOVERY_MODEL?.trim() || "groq/openai/gpt-oss-120b",
    agentId,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}
