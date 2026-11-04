"use client";

import { ChevronDown, CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { bankingFetch } from "@/lib/banking-api";
import type {
  FraudIntelligenceView,
  FraudIntelligenceViewResponse,
  InvestigationStage,
  InvestigationStageId,
  JsonValue,
} from "@/lib/fraud-intelligence-view";

type BreakdownSection = {
  id: string;
  title: string;
  description: string;
  stages: InvestigationStage[];
  fields?: Array<{ label: string; value: JsonValue }>;
  shadowOnly?: boolean;
};

const HIDDEN_DETAIL_KEYS = new Set(["rawJson", "structuredResponse"]);

export function FraudDecisionBreakdown({ paymentId }: { paymentId: string }) {
  const [data, setData] = useState<FraudIntelligenceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await bankingFetch<FraudIntelligenceViewResponse>(
        `/api/v1/payments/${encodeURIComponent(paymentId)}/fraud-intelligence`,
      );
      setData(response.investigation);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Fraud evidence is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [paymentId]);

  useEffect(() => { void load(); }, [load]);

  const sections = useMemo(() => data ? buildSections(data) : [], [data]);

  return (
    <details data-testid="fraud-decision-breakdown" className="group mt-5 max-w-[680px] overflow-hidden rounded-[18px] border border-[#d9e5d7] bg-[#f9fcf7] shadow-[0_10px_30px_#173f3308]">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 marker:content-none">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#e7f1df] text-[#275A47]">
          <ShieldCheck className="size-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block text-sm font-extrabold tracking-[-.2px] text-[#173f33]">Fraud decision breakdown</strong>
          <span className="mt-0.5 block text-[10px] leading-relaxed text-[#68796e]">Persisted evidence for this payment · read only</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-[#55705e] transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>

      <div className="border-t border-[#dfe8dc] px-5 py-5">
        {loading && (
          <p className="flex items-center gap-2 text-xs text-[#68796e]">
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" /> Loading persisted evidence…
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-[#efd4d0] bg-[#fff6f4] p-3 text-[11px] leading-relaxed text-[#8c4841]" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => void load()} className="font-bold underline">Retry</button>
          </div>
        )}
        {!loading && !error && sections.length === 0 && (
          <p className="text-xs text-[#68796e]">No transaction-scoped fraud evidence is available yet.</p>
        )}
        {!loading && !error && sections.length > 0 && (
          <div className="space-y-3">
            {sections.map((section) => <EvidenceSection section={section} key={section.id} />)}
          </div>
        )}
      </div>
    </details>
  );
}

function EvidenceSection({ section }: { section: BreakdownSection }) {
  return (
    <section className="rounded-[14px] border border-[#dfe8dc] bg-white p-4" aria-labelledby={`breakdown-${section.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={`breakdown-${section.id}`} className="text-xs font-extrabold text-[#214737]">{section.title}</h3>
          <p className="mt-1 text-[10px] leading-relaxed text-[#718077]">{section.description}</p>
        </div>
        {section.shadowOnly && <span className="rounded-full border border-[#cdd8d0] bg-[#f0f4f0] px-2 py-1 text-[8px] font-extrabold tracking-[.08em] text-[#64766a]">SHADOW ONLY</span>}
      </div>

      {section.fields && section.fields.length > 0 && <EvidenceRows entries={section.fields} />}
      {section.stages.map((stage) => (
        <div className="mt-3 border-t border-[#edf1eb] pt-3" key={stage.id}>
          {section.stages.length > 1 && <p className="mb-2 text-[9px] font-extrabold uppercase tracking-[.08em] text-[#6b7c70]">{stage.label}</p>}
          <EvidenceRows entries={visibleDetails(stage)} />
        </div>
      ))}
    </section>
  );
}

function EvidenceRows({ entries }: { entries: Array<{ label: string; value: JsonValue }> }) {
  return (
    <dl className="mt-2 divide-y divide-[#edf1eb]">
      {entries.map(({ label, value }) => (
        <div className="grid gap-1 py-2 text-[10px] sm:grid-cols-[150px_minmax(0,1fr)]" key={label}>
          <dt className="font-bold text-[#607166]">{humanise(label)}</dt>
          <dd className="min-w-0 break-words text-[#294b3a]"><EvidenceValue value={value} /></dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="text-[#89968e]">Not recorded</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "string" || typeof value === "number") return <>{String(value)}</>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[#89968e]">None recorded</span>;
    return <ul className="space-y-1">{value.map((item, index) => <li className="before:mr-1.5 before:content-['•']" key={index}><EvidenceValue value={item} /></li>)}</ul>;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-[#89968e]">None recorded</span>;
  return <dl className="space-y-1.5">{entries.map(([key, item]) => <div key={key}><dt className="inline font-semibold">{humanise(key)}: </dt><dd className="inline"><EvidenceValue value={item} /></dd></div>)}</dl>;
}

function buildSections(data: FraudIntelligenceView): BreakdownSection[] {
  const byId = new Map(data.stages.map((stage) => [stage.id, stage]));
  const available = (...ids: InvestigationStageId[]) => ids
    .map((id) => byId.get(id))
    .filter((stage): stage is InvestigationStage => Boolean(stage && stage.observation !== "UNOBSERVED" && stage.status !== "NOT_APPLICABLE"));
  const sections: BreakdownSection[] = [];

  addSection(sections, "flink", "Apache Flink", "Detected fraud signals and supporting transaction features.", available("flink_enrichment"));
  addSection(sections, "router", "Deterministic router", "Authoritative decision, triggered rules and policy evidence.", available("authoritative_policy"));
  addSection(sections, "lightgbm", "LightGBM", "Persisted experimental model evidence; it cannot change the payment decision.", available("lightgbm_shadow"), true);
  addSection(sections, "go", "Go correlator", "Correlated evidence and shadow decision recorded for this transaction.", available("go_correlation", "go_shadow_policy"), true);

  const providerStage = byId.get("fraud_intelligence_provider");
  const providerIsWatsonx = providerStage?.component === "IBM" || providerStage?.label.toLowerCase().includes("watsonx");
  const provider = providerIsWatsonx ? available("fraud_intelligence_provider", "structured_evidence") : [];
  addSection(sections, "watsonx", "watsonx Orchestrate", "Extracted fraud indicators and evidence supporting the reassessment.", provider);

  const outcomeStages = available("governed_reassessment", "simulated_outcome");
  const submitted = byId.get("payment_submitted");
  const ledgerEffect = submitted?.details.ledgerEffect;
  sections.push({
    id: "outcome",
    title: "Payment outcome",
    description: "Original verdict, reassessment outcome and recorded movement of money.",
    stages: outcomeStages,
    fields: [
      { label: "Original verdict", value: data.authoritativeVerdict },
      ...(ledgerEffect !== undefined ? [{ label: "Money moved", value: ledgerEffect === "NONE" ? "No" : ledgerEffect }] : []),
    ],
  });
  return sections;
}

function addSection(sections: BreakdownSection[], id: string, title: string, description: string, stages: InvestigationStage[], shadowOnly = false) {
  if (stages.length > 0) sections.push({ id, title, description, stages, shadowOnly });
}

function visibleDetails(stage: InvestigationStage) {
  return Object.entries(stage.details)
    .filter(([key, value]) => !HIDDEN_DETAIL_KEYS.has(key) && value !== null && value !== undefined)
    .map(([label, value]) => ({ label, value }));
}

function humanise(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}
