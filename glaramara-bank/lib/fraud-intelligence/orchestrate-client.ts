import "server-only";

import {
  fraudEvidenceSchema,
  mockedEvidence,
  type FraudEvidence,
  type MinimalInvestigationContext,
} from "@/lib/fraud-intelligence/evidence";
import { IbmIamTokenProvider, withOneIamRetry } from "@/lib/fraud-intelligence/ibm-iam";

const FRAUD_INTELLIGENCE_AGENT_ID = "f7859afd-0e8d-488e-88c3-64b591330524";
const iamTokenProvider = new IbmIamTokenProvider();

export type ExtractionResult = {
  evidence: FraudEvidence;
  provider: string;
  model: string;
  latencyMs: number;
};

type RunnerEnvelope = {
  ok: boolean;
  evidence?: unknown;
  latencyMs?: number;
  errorType?: string;
};

export function fraudIntelligenceProvider(): string {
  const provider = process.env.FRAUD_INTELLIGENCE_PROVIDER?.trim();
  if (provider) return provider;

  // Compatibility for existing ignored local configuration and the bounded
  // Phase C launcher. New deployments use FRAUD_INTELLIGENCE_PROVIDER.
  const legacyMode = process.env.FRAUD_INTELLIGENCE_MODE?.trim();
  if (legacyMode === "orchestrate-rest") return "orchestrate";
  return legacyMode || "disabled";
}

function orchestrateBaseUrl(): string {
  const configured = process.env.WATSONX_ORCHESTRATE_URL?.trim();
  if (!configured) throw new Error("WATSONX_ORCHESTRATE_URL is required for REST extraction");
  const url = new URL(configured);
  if (url.protocol !== "https:"
      || !url.hostname.endsWith(".watson-orchestrate.cloud.ibm.com")
      || !/^\/instances\/[0-9a-f-]{36}\/?$/i.test(url.pathname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("WATSONX_ORCHESTRATE_URL is not a supported IBM Cloud service instance URL");
  }
  return url.toString().replace(/\/$/, "");
}

function findSchemaEvidence(value: unknown): unknown | undefined {
  if (typeof value === "string") {
    const candidate = value.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      return findSchemaEvidence(JSON.parse(candidate));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const evidence = findSchemaEvidence(item);
      if (evidence !== undefined) return evidence;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.schemaVersion === "fraud-intelligence-evidence/1.0.0") return record;
    for (const item of Object.values(record)) {
      const evidence = findSchemaEvidence(item);
      if (evidence !== undefined) return evidence;
    }
  }
  return undefined;
}

async function runRestAdapter(context: MinimalInvestigationContext): Promise<RunnerEnvelope> {
  const timeoutMs = Number(process.env.FRAUD_INTELLIGENCE_TIMEOUT_MS ?? "45000");
  const endpoint = `${orchestrateBaseUrl()}/v1/orchestrate/${FRAUD_INTELLIGENCE_AGENT_ID}/chat/completions`;
  const started = performance.now();
  const response = await withOneIamRetry(iamTokenProvider, (accessToken) => fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: JSON.stringify(context) }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  if (!response.ok) {
    throw new Error(`Fraud Intelligence REST request failed with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  const evidence = findSchemaEvidence(payload);
  if (evidence === undefined) {
    throw new Error("Fraud Intelligence REST response contained no schema-versioned evidence");
  }
  return { ok: true, evidence, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
}

export async function extractFraudEvidence(context: MinimalInvestigationContext): Promise<ExtractionResult> {
  const provider = fraudIntelligenceProvider();
  if (provider === "mock") {
    const started = performance.now();
    return {
      evidence: mockedEvidence(context),
      provider: "deterministic-fixture",
      model: "mock-fraud-intelligence/1.0.0",
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
  if (provider !== "orchestrate") {
    throw new Error("Fraud Intelligence execution is disabled");
  }
  const envelope = await runRestAdapter(context);
  if (!envelope.ok) throw new Error(`Fraud Intelligence failed: ${envelope.errorType ?? "UNKNOWN"}`);
  return {
    evidence: fraudEvidenceSchema.parse(envelope.evidence),
    provider: "watsonx-orchestrate-rest",
    model: process.env.FRAUD_INTELLIGENCE_MODEL?.trim() || "groq/openai/gpt-oss-120b",
    latencyMs: envelope.latencyMs ?? 0,
  };
}
