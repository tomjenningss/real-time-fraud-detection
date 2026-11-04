"use client";

import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cpu,
  Database,
  FileSearch,
  Scale,
  ShieldCheck,
  UserCheck,
  XCircle,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSystemView } from "@/components/fraud-intelligence/system-view-provider";
import { bankingFetch } from "@/lib/banking-api";

type RunSummary = {
  id: string;
  status: string;
  snapshotRowCount: number;
  startedAt: string;
  finishedAt: string | null;
  candidateId: string | null;
  ruleName: string | null;
  candidateStatus: string | null;
};
type FraudLabDataset = {
  id: string;
  generatorVersion: string;
  seed: string;
  requestedTransactionCount: number;
  actualTransactionCount: number | null;
  fraudScenarioId: string;
  status: "PENDING" | "GENERATING" | "READY" | "FAILED";
  contentSha256: string | null;
  requestedAt: string;
  generatedAt: string | null;
  failureCode: string | null;
  active: boolean;
};
type Dashboard = {
  synthetic: true;
  activeDatasetId: string | null;
  datasets: FraudLabDataset[];
  dataset: {
    totalTransactions: number;
    fraudLabelled: number;
    baselineFraudDetected: number;
    baselineCoverage: number;
  };
  waves: Array<{
    id: string;
    rowCount: number;
    discoveryCount: number;
    evaluationCount: number;
    seed: number;
    contentSha256: string;
  }>;
  runs: RunSummary[];
};
type Proposal = {
  schemaVersion: string;
  ruleIdentifier: string;
  name: string;
  description: string;
  rationale: string;
  action: string;
  uncertainty: string;
  logicalOperator: "ALL";
  conditions: Array<{ featureId: string; operator: string; threshold: number; window: string | null }>;
  supportingEvidenceRefs: string[];
  limitations: string[];
};
type DiscoveryCohort = {
  evidenceRef: string;
  featureId: string;
  operator: string;
  threshold: number;
  transactionCount: number;
  fraudLabelCount: number;
  genuineLabelCount: number;
  baselineMissedFraudCount: number;
  baselineDetectedCount: number;
};
type DiscoveryReport = {
  dataBoundary: string;
  summary: {
    transactionCount: number;
    fraudLabelCount: number;
    genuineLabelCount: number;
    baselineDetectedFraudCount: number;
    baselineMissedFraudCount: number;
    baselinePolicyVersion: string;
  };
  featureCatalogue: Array<{ id: string; description: string }>;
  cohorts: DiscoveryCohort[];
};
type Score = {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
};
type Metrics = {
  baseline: Score;
  candidate: Score;
  combined: Score;
  additionalFraudDetected: number;
  additionalLegitimateChallenged: number;
  overlapWithBaseline: number;
};
type RunDetail = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  snapshot: unknown;
  discoveryReport: DiscoveryReport | null;
  snapshotSha256: string;
  snapshotRowCount: number;
  errorType: string | null;
  agent: { provider: string; model: string; agentId: string; latencyMs: number } | null;
  candidate: null | {
    id: string;
    fingerprint: string;
    duplicateOfCandidateId: string | null;
    status: string;
    proposal: Proposal;
    backtest: null | {
      evaluatorVersion: string;
      metrics: Metrics;
      examples: { additionalFraud: string[]; falsePositives: string[]; overlap: string[] };
      semanticsNote: string;
    };
    review: null | { decision: string; reason: string | null; reviewedAt: string };
  };
};

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function label(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function windowLabel(window: string | null) {
  const labels: Record<string, string> = { PT1M: "1 minute", PT2M: "2 minutes", PT10M: "10 minutes", PT24H: "24 hours" };
  return window ? labels[window] ?? window : "current payment";
}

function operatorLabel(operator: string) {
  return ({ GT: "More than", GTE: "At least", LT: "Less than", LTE: "At most", EQ: "Exactly" } as Record<string, string>)[operator] ?? label(operator);
}

export function FraudOperationsClient() {
  const systemView = useSystemView();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const [selectedSize, setSelectedSize] = useState<8_000 | 10_000 | 20_000>(8_000);
  const [activationConfirmed, setActivationConfirmed] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const latestRunRequested = useRef(false);

  const refresh = useCallback(async () => {
    const data = await bankingFetch<Dashboard>("/api/v1/fraud-operations");
    setDashboard(data);
  }, []);

  const loadRun = useCallback(async (runId: string) => {
    setError(null);
    setRunLoading(true);
    try {
      const response = await bankingFetch<{ run: RunDetail }>(`/api/v1/fraud-operations/runs/${runId}`);
      setRun(response.run);
      setReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation unavailable.");
    } finally {
      setRunLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Dashboard unavailable."));
  }, [refresh]);

  useEffect(() => {
    if (!dashboard?.datasets.some((dataset) => dataset.status === "PENDING" || dataset.status === "GENERATING")) return;
    const timer = window.setTimeout(() => {
      refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Dataset status unavailable."));
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [dashboard, refresh]);

  useEffect(() => {
    if (!dashboard || latestRunRequested.current || run) return;
    latestRunRequested.current = true;
    const latestCompleted = dashboard.runs.find((item) => item.status === "COMPLETED" && item.candidateId);
    if (latestCompleted) void loadRun(latestCompleted.id);
  }, [dashboard, loadRun, run]);

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const response = await bankingFetch<{ run: RunDetail }>("/api/v1/fraud-operations/analyses", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setRun(response.run);
      setReason("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pattern analysis failed.");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function generateDataset() {
    setDatasetBusy(true);
    setError(null);
    setActivationConfirmed(false);
    try {
      await bankingFetch("/api/v1/fraud-operations/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ transactionCount: selectedSize }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dataset generation could not be requested.");
    } finally {
      setDatasetBusy(false);
    }
  }

  async function activateDataset(datasetId: string) {
    if (!activationConfirmed) return;
    setDatasetBusy(true);
    setError(null);
    try {
      await bankingFetch(`/api/v1/fraud-operations/datasets/${datasetId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "ACTIVATE" }),
      });
      setActivationConfirmed(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dataset activation failed.");
    } finally {
      setDatasetBusy(false);
    }
  }

  async function review(decision: "APPROVED_FOR_IMPLEMENTATION" | "REJECTED") {
    if (!run?.candidate) return;
    setBusy(true);
    setError(null);
    try {
      const response = await bankingFetch<{ run: RunDetail }>(
        `/api/v1/fraud-operations/candidates/${run.candidate.id}/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, reason: reason || undefined }),
        },
      );
      setRun(response.run);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  const data = dashboard?.dataset;
  const activeDataset = dashboard?.datasets.find((dataset) => dataset.active);
  const latestDataset = dashboard?.datasets[0];
  const generationInProgress = dashboard?.datasets.some(
    (dataset) => dataset.status === "PENDING" || dataset.status === "GENERATING",
  ) ?? false;
  const activatableDataset = latestDataset?.status === "READY" && !latestDataset.active ? latestDataset : null;
  const candidate = run?.candidate;
  const backtest = candidate?.backtest;
  const metrics = backtest?.metrics;
  const evaluationCount = metrics
    ? metrics.baseline.truePositives + metrics.baseline.falsePositives
      + metrics.baseline.trueNegatives + metrics.baseline.falseNegatives
    : null;
  const fraudEvaluationCount = metrics ? metrics.baseline.truePositives + metrics.baseline.falseNegatives : 0;
  const missedFraudRate = fraudEvaluationCount ? metrics!.baseline.falseNegatives / fraudEvaluationCount : 0;
  const persistedPattern = run?.discoveryReport?.cohorts
    .filter((cohort) => candidate?.proposal.supportingEvidenceRefs.includes(cohort.evidenceRef))
    .sort((left, right) => right.baselineMissedFraudCount - left.baselineMissedFraudCount)[0];

  return (
    <div className="space-y-5">
      <section className="rounded-[20px] bg-[linear-gradient(130deg,#13392e,#205543_65%,#295e4a)] p-6 text-white shadow-[0_16px_30px_rgba(23,63,51,.14)] md:p-8">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div className="max-w-2xl">
            <p className="text-[10px] font-extrabold tracking-[.18em] text-[#c9e4d1]">SYNTHETIC FRAUD LAB · HUMAN DECISION REQUIRED</p>
            <h2 className="mt-3 text-2xl font-extrabold tracking-[-.8px] md:text-3xl">From emerging pattern to measured decision</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#d8eadc]">
              Follow one immutable investigation from Glaramara&apos;s evidence, through a watsonx Orchestrate proposal, to an independent backtest and analyst review.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row md:flex-col">
            <label className="relative flex cursor-pointer items-center justify-center gap-2 rounded-full border border-[#ffffff33] bg-[#ffffff12] px-4 py-2 text-[10px] font-extrabold tracking-[.06em] text-white">
              <Cpu className="size-3.5" aria-hidden="true" />{systemView.enabled ? "SYSTEM VIEW" : "ANALYST VIEW"}
              <input type="checkbox" className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" checked={systemView.enabled} disabled={!systemView.ready} onChange={(event) => systemView.setEnabled(event.target.checked)} aria-label="Toggle System View technical evidence" />
              <span className="relative h-[18px] w-8 rounded-full bg-[#ffffff42] transition peer-checked:bg-[#b9dcae] after:absolute after:left-[3px] after:top-[3px] after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[14px]" />
            </label>
            <Button onClick={() => void analyse()} disabled={busy || !dashboard?.waves.length} className="min-w-[210px] bg-[#d6e9b8] text-[#173f33] hover:bg-[#e4f2cc]">
              <BrainCircuit className="mr-2 size-4" />{busy ? "Analysing patterns…" : "Run new analysis"}
            </Button>
          </div>
        </div>
      </section>

      {error && <div role="alert" className="rounded-xl border border-[#e8caca] bg-[#fff3f2] p-4 text-sm text-[#8c3434]"><AlertTriangle className="mr-2 inline size-4" />{error}</div>}
      {busy && <div role="status" className="rounded-xl border border-[#d7e4cf] bg-white p-4 text-sm text-[#49644f]">Creating an immutable snapshot, asking watsonx Orchestrate for one proposal, then running Glaramara&apos;s deterministic held-out backtest. This can take up to a minute.</div>}
      {runLoading && !run && <div role="status" className="rounded-xl border border-[#d7e4cf] bg-white p-4 text-sm text-[#49644f]">Loading the latest completed investigation…</div>}

      <Card className="border-[#cfdfca] bg-[#f8fbf6] p-5" aria-label="Fraud Scenario Lab">
        <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-start">
          <div>
            <p className="text-[10px] font-extrabold tracking-[.14em] text-[#56735f]">FRAUD SCENARIO LAB · SYNTHETIC DATA ONLY</p>
            <h2 className="mt-1 text-lg font-extrabold text-[#203d30]">Generate data, then choose when to analyse it</h2>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[#5d6f63]">
              Generation creates a new immutable synthetic dataset. Activation selects it for future investigations. Neither action contacts watsonx Orchestrate; analysis starts only from the separate Run new analysis button.
            </p>
            <fieldset className="mt-4 flex flex-wrap gap-2">
              <legend className="sr-only">Synthetic transaction count</legend>
              {([8_000, 10_000, 20_000] as const).map((size) => (
                <label key={size} className={`cursor-pointer rounded-full border px-4 py-2 text-xs font-bold ${selectedSize === size ? "border-[#4f805f] bg-[#e5f0df] text-[#28583e]" : "border-[#d9e4d5] bg-white text-[#5b6b60]"}`}>
                  <input className="sr-only" type="radio" name="dataset-size" value={size} checked={selectedSize === size} onChange={() => setSelectedSize(size)} />
                  {size.toLocaleString()} transactions
                </label>
              ))}
            </fieldset>
            <Button className="mt-3" variant="secondary" disabled={datasetBusy || generationInProgress} onClick={() => void generateDataset()}>
              <Database className="mr-2 size-4" />{generationInProgress ? "Generation in progress…" : "Generate new dataset"}
            </Button>
          </div>
          <div className="min-w-[250px] rounded-xl border border-[#dce6d8] bg-white p-4 text-xs text-[#53665a]">
            <p><strong>Active:</strong> {activeDataset ? `${activeDataset.actualTransactionCount?.toLocaleString()} transactions` : "None"}</p>
            {latestDataset && <p className="mt-2"><strong>Latest:</strong> {latestDataset.requestedTransactionCount.toLocaleString()} · {label(latestDataset.status)}</p>}
            {latestDataset?.status === "FAILED" && <p className="mt-2 text-[#8c3434]">Generation failed safely ({latestDataset.failureCode ?? "unknown error"}). You can request another dataset.</p>}
            {activatableDataset && (
              <div className="mt-3 border-t border-[#e5ebe2] pt-3">
                <label className="flex items-start gap-2"><input type="checkbox" checked={activationConfirmed} onChange={(event) => setActivationConfirmed(event.target.checked)} /><span>Confirm activation for future investigations.</span></label>
                <Button className="mt-3 w-full" disabled={datasetBusy || !activationConfirmed} onClick={() => void activateDataset(activatableDataset.id)}>Activate completed dataset</Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fraud Lab overview">
        <Metric icon={Database} label="Current active dataset" value={data ? `${data.totalTransactions.toLocaleString()} transactions` : "—"} />
        <Metric icon={AlertTriangle} label="Independently fraud-labelled" value={data?.fraudLabelled.toLocaleString() ?? "—"} />
        <Metric icon={ShieldCheck} label="Existing rule coverage" value={data ? percent(data.baselineCoverage) : "—"} />
        <Metric icon={Clock3} label="Immutable data waves" value={dashboard?.waves.length.toString() ?? "—"} />
      </section>

      {run && !candidate && !runLoading && (
        <Card className="border-[#ead9cf] bg-[#fffaf6] p-5">
          <p className="text-xs font-extrabold tracking-[.12em] text-[#8a5d43]">INVESTIGATION {label(run.status)}</p>
          <h2 className="mt-2 text-lg font-extrabold">No validated proposal is available for this run</h2>
          <p className="mt-2 text-sm text-[#6f6259]">{run.errorType ? `Recorded failure: ${label(run.errorType)}.` : "The run contains no candidate evidence."} Select another investigation from history or run a new analysis.</p>
        </Card>
      )}

      {run && candidate && (
        <section className="space-y-4" aria-label="Five-stage investigation narrative">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#d8e4d4] bg-[#f7faf5] px-4 py-3 text-xs text-[#4c6655]">
            <span><strong>Immutable investigation:</strong> {run.snapshotRowCount.toLocaleString()} transactions · {new Date(run.finishedAt ?? run.startedAt ?? Date.now()).toLocaleString()}</span>
            <span className="font-semibold">{label(candidate.status)}</span>
          </div>

          <NarrativeStage number="01" eyebrow="GLARAMARA OBSERVATION" title="Emerging pattern" icon={FileSearch}>
            {persistedPattern ? <p className="text-sm leading-relaxed text-[#52675a]">
              In the persisted discovery evidence, <strong>{persistedPattern.transactionCount.toLocaleString()} synthetic payments</strong> matched a recurring behaviour: <strong>{label(persistedPattern.featureId)}</strong> was {operatorLabel(persistedPattern.operator).toLowerCase()} <strong>{persistedPattern.threshold.toLocaleString()}</strong>. This group contained {persistedPattern.fraudLabelCount.toLocaleString()} fraud-labelled payments, including {persistedPattern.baselineMissedFraudCount.toLocaleString()} missed by existing controls.
            </p> : <p className="text-sm leading-relaxed text-[#52675a]">
              Glaramara preserved a synthetic discovery snapshot for pattern analysis, but this investigation does not contain a specific persisted cohort summary. The Orchestrate proposal below remains a hypothesis, not independently verified evidence.
            </p>}
            <p className="mt-3 text-xs text-[#68786e]">The discovery evidence and held-out evaluation payments were kept separate. Orchestrate interpreted the discovery evidence; it did not independently verify the behaviour.</p>
            {data && data.totalTransactions !== run.snapshotRowCount && <p className="mt-3 text-xs text-[#68786e]">This historical investigation remains tied to its original snapshot; the current active dataset now contains {data.totalTransactions.toLocaleString()} transactions.</p>}
          </NarrativeStage>

          <NarrativeStage number="02" eyebrow="GLARAMARA OBSERVATION" title="Detection gap" icon={AlertTriangle}>
            {metrics ? (
              <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
                <p className="text-sm leading-relaxed text-[#52675a]">
                  In this synthetic evaluation, existing controls detected <strong>{metrics.baseline.truePositives.toLocaleString()}</strong> fraud-labelled payments and missed <strong>{metrics.baseline.falseNegatives.toLocaleString()}</strong>, or <strong>{percent(missedFraudRate)}</strong> of all fraud-labelled payments. Baseline recall—the percentage of fraud detected—was <strong>{percent(metrics.baseline.recall)}</strong>.
                </p>
                <div className="rounded-xl bg-[#fff7e7] px-5 py-4 text-center text-[#785f31]">
                  <p className="text-3xl font-extrabold">{metrics.baseline.falseNegatives.toLocaleString()}</p>
                  <p className="mt-1 text-[11px] font-bold">fraud cases missed</p>
                </div>
              </div>
            ) : <Unavailable text="No deterministic backtest is stored for this proposal." />}
          </NarrativeStage>

          <NarrativeStage number="03" eyebrow="GENERATED BY WATSONX ORCHESTRATE" title="Proposed rule" icon={BrainCircuit}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-3xl">
                <h3 className="text-xl font-extrabold text-[#203d30]">{candidate.proposal.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#52675a]">{candidate.proposal.description}</p>
              </div>
              <span className="rounded-full bg-[#e6f0df] px-3 py-1 text-xs font-bold text-[#315f45]">Proposed action: {candidate.proposal.action}</span>
            </div>
            {candidate.duplicateOfCandidateId && <p className="mt-3 rounded-lg bg-[#fff8e8] p-3 text-xs text-[#765e2d]">This proposal duplicates an earlier persisted candidate{systemView.enabled ? ` (${candidate.duplicateOfCandidateId})` : ""}.</p>}
            <div className="mt-5 rounded-xl border-l-4 border-[#6f9d70] bg-[#f6faf4] p-4">
              <p className="text-[10px] font-extrabold tracking-[.12em] text-[#54715d]">ORCHESTRATE RATIONALE</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3f5648]">{candidate.proposal.rationale}</p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-[10px] font-extrabold tracking-[.12em] text-[#607066]">RULE CONDITIONS</p>
                <div className="mt-2 space-y-2">
                  {candidate.proposal.conditions.map((condition) => (
                    <div key={`${condition.featureId}:${condition.window}:${condition.threshold}`} className="rounded-xl border border-[#e1e9de] bg-white p-3 text-xs">
                      <strong>{label(condition.featureId)}</strong><br />{operatorLabel(condition.operator)} {condition.threshold.toLocaleString()} within {windowLabel(condition.window)}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-extrabold tracking-[.12em] text-[#607066]">UNCERTAINTY &amp; LIMITATIONS</p>
                <p className="mt-2 inline-flex rounded-full bg-[#fff3d9] px-3 py-1 text-xs font-bold text-[#765e2d]">{label(candidate.proposal.uncertainty)} uncertainty</p>
                {candidate.proposal.limitations.length ? <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[#5c675f]">{candidate.proposal.limitations.map((limitation) => <li key={limitation} className="flex gap-2"><span aria-hidden="true">•</span><span>{limitation}</span></li>)}</ul> : <p className="mt-3 text-xs text-[#68786e]">No limitations were recorded.</p>}
              </div>
            </div>
            {systemView.enabled && <ProposalTechnicalDetails proposal={candidate.proposal} backtestSemantics={backtest?.semanticsNote ?? null} />}
          </NarrativeStage>

          <NarrativeStage number="04" eyebrow="CALCULATED DETERMINISTICALLY BY GLARAMARA" title="Independent backtest" icon={Scale} emphasised>
            {metrics && backtest ? (
              <>
                <p className="max-w-3xl text-sm leading-relaxed text-[#52675a]">
                  These <strong>{evaluationCount?.toLocaleString()} synthetic payments</strong> were reserved and not shown to Orchestrate, providing an independent evaluation. The proposed rule detected <strong>{metrics.additionalFraudDetected.toLocaleString()} additional fraud cases</strong> and would have challenged <strong>{metrics.additionalLegitimateChallenged.toLocaleString()} additional legitimate payments</strong> beyond existing controls. Recall is the percentage of fraud-labelled payments detected.
                </p>
                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <ResultCard title="Additional fraud detected" value={metrics.additionalFraudDetected} tone="good" />
                  <ResultCard title="Additional legitimate challenged" value={metrics.additionalLegitimateChallenged} tone="warning" />
                  <Card className="flex items-center justify-center gap-4 border-[#dce7d8] bg-white p-5 text-center">
                    <div><p className="text-2xl font-extrabold text-[#52675a]">{percent(metrics.baseline.recall)}</p><p className="text-[10px] font-bold text-[#68786e]">BASELINE RECALL</p></div>
                    <ArrowRight className="size-5 text-[#75927e]" aria-hidden="true" />
                    <div><p className="text-2xl font-extrabold text-[#285e43]">{percent(metrics.combined.recall)}</p><p className="text-[10px] font-bold text-[#4e745d]">COMBINED RECALL</p></div>
                  </Card>
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <RecallComparisonChart baseline={metrics.baseline.recall} combined={metrics.combined.recall} />
                  <DetectionFrictionChart fraud={metrics.additionalFraudDetected} legitimate={metrics.additionalLegitimateChallenged} />
                </div>
                {systemView.enabled && <TechnicalDetails run={run} metrics={metrics} evaluationCount={evaluationCount} />}
              </>
            ) : <Unavailable text="This proposal has no persisted backtest results." />}
          </NarrativeStage>

          <NarrativeStage number="05" eyebrow="HUMAN AUTHORITY" title="Human analyst decision" icon={UserCheck}>
            <p className="text-sm leading-relaxed text-[#52675a]">The evidence is advisory. Only the fraud analyst can approve this candidate for future engineering or reject it. Either choice leaves live detection controls and payment decisions unchanged.</p>
            {!candidate.review && candidate.status === "BACKTESTED" && (
              <div className="mt-5">
                <label htmlFor="review-reason" className="text-xs font-bold">Optional review rationale</label>
                <textarea id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Record the evidence and trade-off behind your decision" className="mt-2 min-h-20 w-full rounded-xl border border-[#dce5d9] p-3 text-sm outline-none focus:ring-2 focus:ring-[#6b9d73]" />
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button disabled={busy} onClick={() => void review("APPROVED_FOR_IMPLEMENTATION")}><CheckCircle2 className="mr-2 size-4" />Approve for future engineering</Button>
                  <Button disabled={busy} variant="secondary" onClick={() => void review("REJECTED")}><XCircle className="mr-2 size-4" />Reject proposal</Button>
                </div>
              </div>
            )}
            {candidate.review?.decision === "APPROVED_FOR_IMPLEMENTATION" && <DecisionBanner tone="approved" text="Approved for future engineering. No live fraud detection controls have been changed." reason={candidate.review.reason} />}
            {candidate.review?.decision === "REJECTED" && <DecisionBanner tone="rejected" text="Proposal rejected. No live fraud detection controls have been changed." reason={candidate.review.reason} />}
          </NarrativeStage>
        </section>
      )}

      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-bold">Investigation history</h2><p className="text-[10px] text-[#68786e]">Current active dataset: {data?.totalTransactions.toLocaleString() ?? "—"} transactions</p></div>
        <div className="mt-3 divide-y divide-[#e7ece5]">
          {dashboard?.runs.length ? dashboard.runs.map((item) => (
            <button type="button" key={item.id} onClick={() => void loadRun(item.id)} aria-current={run?.id === item.id ? "true" : undefined} className="flex w-full items-center justify-between gap-3 py-3 text-left text-xs hover:text-[#276144] aria-[current=true]:text-[#276144]">
              <span><strong>{item.ruleName ?? "Analysis run"}</strong><br /><span className="text-[#68786e]">{new Date(item.startedAt).toLocaleString()} · Historical snapshot: {item.snapshotRowCount.toLocaleString()} transactions</span></span>
              <span className="font-bold">{label(item.candidateStatus ?? item.status)} →</span>
            </button>
          )) : <p className="py-3 text-xs text-[#68786e]">No investigations have been run yet.</p>}
        </div>
      </Card>
    </div>
  );
}

function NarrativeStage({ number, eyebrow, title, icon: Icon, emphasised = false, children }: { number: string; eyebrow: string; title: string; icon: typeof Database; emphasised?: boolean; children: ReactNode }) {
  return <Card className={emphasised ? "border-[#bfd5b8] bg-[#f5faf2] p-5 md:p-6" : "p-5 md:p-6"}><div className="mb-5 flex items-start gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e9f1e4] text-xs font-extrabold text-[#315f45]">{number}</div><div className="min-w-0"><p className="flex items-center gap-1.5 text-[10px] font-extrabold tracking-[.12em] text-[#5a7763]"><Icon className="size-3.5" />{eyebrow}</p><h2 className="mt-1 text-lg font-extrabold text-[#203d30] md:text-xl">{title}</h2></div></div>{children}</Card>;
}

const featureImplementation: Record<string, { entity: string; source: string; state: string }> = {
  amount_gbp: { entity: "customer_id", source: "amount from payments.raw.demo", state: "No rolling state; evaluate the current payment amount." },
  beneficiary_payment_count_before: { entity: "customer_id", source: "beneficiary_payment_count enrichment from payments.raw.demo", state: "Retain or trust the server-derived prior customer-beneficiary payment count." },
  customer_transaction_count: { entity: "customer_id", source: "transaction identity and event_time", state: "Event-time keyed rolling count state for the selected window." },
  customer_total_amount_gbp: { entity: "customer_id", source: "amount and event_time", state: "Event-time keyed rolling amount state for the selected window." },
  customer_distinct_merchant_count: { entity: "customer_id", source: "merchant_id and event_time", state: "Event-time keyed merchant membership/count state." },
  customer_distinct_new_beneficiary_count: { entity: "customer_id", source: "beneficiary identity, prior-payment enrichment and event_time", state: "Customer-beneficiary history plus event-time distinct-beneficiary state." },
  customer_new_beneficiary_payment_count: { entity: "customer_id", source: "beneficiary identity, prior-payment enrichment and event_time", state: "Customer-beneficiary history plus event-time rolling count state." },
  customer_new_beneficiary_total_gbp: { entity: "customer_id", source: "beneficiary identity, prior-payment enrichment, amount and event_time", state: "Customer-beneficiary history plus event-time rolling amount state." },
  beneficiary_distinct_customers: { entity: "beneficiary_id", source: "customer_id, beneficiary identity and event_time", state: "Beneficiary-keyed event-time distinct-customer state." },
};

function ProposalTechnicalDetails({ proposal, backtestSemantics }: { proposal: Proposal; backtestSemantics: string | null }) {
  const contracts = proposal.conditions.map((condition) => featureImplementation[condition.featureId]).filter(Boolean);
  const keyedEntities = [...new Set(contracts.map((contract) => contract.entity))];
  const windows = [...new Set(proposal.conditions.map((condition) => condition.window).filter(Boolean))] as string[];
  const mixedKeys = keyedEntities.length > 1;

  return <div className="mt-5 space-y-3">
    <details className="group rounded-xl border border-[#dce7d8] bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-xs font-bold text-[#385743]">Raw proposal and evidence references<ChevronDown className="size-4 transition group-open:rotate-180" /></summary>
      <div className="border-t border-[#e6ece3] p-4 text-xs text-[#59685e]">
        <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-[max-content_1fr]"><dt className="font-bold">Proposal schema</dt><dd>{proposal.schemaVersion}</dd><dt className="font-bold">Rule identifier</dt><dd>{proposal.ruleIdentifier}</dd><dt className="font-bold">Logic</dt><dd>{proposal.logicalOperator}</dd><dt className="font-bold">Raw conditions</dt><dd className="space-y-1">{proposal.conditions.map((condition) => <code className="block break-all" key={`${condition.featureId}:${condition.window}:${condition.threshold}`}>{condition.featureId} {condition.operator} {condition.threshold} · {condition.window ?? "CURRENT_PAYMENT"}</code>)}</dd><dt className="font-bold">Evidence references</dt><dd className="break-all">{proposal.supportingEvidenceRefs.join(", ")}</dd></dl>
      </div>
    </details>
    <details className="group rounded-xl border border-[#cfdcca] bg-[#f8fbf6]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-xs font-bold text-[#315f45]">Proposed Flink implementation <span className="ml-auto rounded-full bg-[#fff0cf] px-2.5 py-1 text-[9px] font-extrabold text-[#765e2d]">PROPOSED — NOT DEPLOYED</span><ChevronDown className="size-4 transition group-open:rotate-180" /></summary>
      <div className="border-t border-[#dce7d8] p-4 text-xs text-[#52675a]">
        <p className="mb-4 leading-relaxed">Derived from this investigation&apos;s persisted, validated proposal and the current repository contracts. This is an engineering specification only; no Flink or router change exists.</p>
        <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-[max-content_1fr]">
          <dt className="font-bold">Suggested fraud signal</dt><dd>{proposal.ruleIdentifier}</dd>
          <dt className="font-bold">Kafka contracts</dt><dd><code>payments.raw.demo</code> input; transaction assessment on <code>payments.enriched.demo</code>. <code>fraud.signals.demo</code> remains repeating window context, not a router input.</dd>
          <dt className="font-bold">Keyed entity</dt><dd>{keyedEntities.join(" and ") || "customer_id"}{mixedKeys ? "; multiple keyed projections would require an explicitly designed join" : ""}</dd>
          <dt className="font-bold">Required features</dt><dd>{contracts.map((contract) => contract.source).join("; ")}</dd>
          <dt className="font-bold">Window and event time</dt><dd>{windows.length ? windows.map(windowLabel).join(", ") : "Current payment only"}. Preserve the existing two-second out-of-order watermark, deterministic transaction-ID ordering for equal timestamps, late-event side output and at-least-once delivery semantics.</dd>
          <dt className="font-bold">Exact conditions</dt><dd className="space-y-1">{proposal.conditions.map((condition) => <span className="block" key={`${condition.featureId}:${condition.window}:${condition.threshold}`}>{operatorLabel(condition.operator)} {condition.threshold.toLocaleString()} for {label(condition.featureId)} within {windowLabel(condition.window)}</span>)}</dd>
          <dt className="font-bold">Suggested router action</dt><dd>Emit a stable transaction-scoped signal ID and add a versioned deterministic router mapping to <strong>{proposal.action}</strong>, subject to engineering review and existing precedence rules.</dd>
          <dt className="font-bold">Required state/enrichment</dt><dd>{[...new Set(contracts.map((contract) => contract.state))].join(" ")}</dd>
          <dt className="font-bold">Engineering considerations</dt><dd>Define stable signal/version identifiers, schema compatibility, checkpoint/savepoint behaviour, deduplication, state retention, late-event handling and deterministic tests before implementation.</dd>
          <dt className="font-bold">Unsupported semantics</dt><dd>{mixedKeys ? "The current enrichment job is keyed by user/customer; beneficiary-keyed conditions require a separately designed keyed projection and join. " : ""}{backtestSemantics ?? "The batch backtest does not prove streaming watermark, late-event, checkpoint or operational deduplication behaviour."}</dd>
          <dt className="font-bold">Status</dt><dd><strong>PROPOSED — NOT DEPLOYED</strong></dd>
        </dl>
      </div>
    </details>
  </div>;
}

function TechnicalDetails({ run, metrics, evaluationCount }: { run: RunDetail; metrics: Metrics; evaluationCount: number | null }) {
  const backtest = run.candidate?.backtest;
  if (!backtest) return null;
  return <details className="group mt-5 rounded-xl border border-[#dce7d8] bg-white"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-xs font-bold text-[#385743]">Technical evidence and provenance<ChevronDown className="size-4 transition group-open:rotate-180" /></summary><div className="border-t border-[#e6ece3] p-4 text-xs text-[#59685e]"><div className="grid gap-4 lg:grid-cols-3"><ScoreCard title="Existing baseline" score={metrics.baseline} /><ScoreCard title="Candidate alone" score={metrics.candidate} /><ScoreCard title="Baseline + candidate" score={metrics.combined} /></div><dl className="mt-5 grid gap-x-5 gap-y-3 sm:grid-cols-[max-content_1fr]"><dt className="font-bold">Evaluation set</dt><dd>{evaluationCount?.toLocaleString() ?? "Unavailable"} held-out transactions</dd><dt className="font-bold">Existing-control overlap</dt><dd>{metrics.overlapWithBaseline.toLocaleString()} transactions</dd><dt className="font-bold">Evaluator</dt><dd>{backtest.evaluatorVersion}</dd><dt className="font-bold">Semantics</dt><dd>{backtest.semanticsNote}</dd><dt className="font-bold">Orchestrate provider</dt><dd>{run.agent ? `${run.agent.provider} · ${run.agent.model} · ${run.agent.latencyMs.toLocaleString()} ms` : "Not recorded"}</dd><dt className="font-bold">Snapshot</dt><dd className="break-all">{run.snapshotSha256}</dd></dl><details className="mt-4 rounded-lg bg-[#f7faf5] p-3"><summary className="cursor-pointer font-bold">Transaction references</summary><div className="mt-3 space-y-2 break-all text-[10px]"><p><strong>Additional fraud:</strong> {backtest.examples.additionalFraud.join(", ") || "None recorded"}</p><p><strong>Additional legitimate challenges:</strong> {backtest.examples.falsePositives.join(", ") || "None recorded"}</p><p><strong>Existing-control overlap:</strong> {backtest.examples.overlap.join(", ") || "None recorded"}</p></div></details><details className="mt-3 rounded-lg bg-[#f7faf5] p-3"><summary className="cursor-pointer font-bold">Proposal evidence references</summary><p className="mt-3 break-all text-[10px]">{run.candidate?.proposal.supportingEvidenceRefs.join(", ") || "None recorded"}</p></details></div></details>;
}

function Metric({ icon: Icon, label: caption, value }: { icon: typeof Database; label: string; value: string }) {
  return <Card className="p-5"><Icon className="size-5 text-[#3f7858]" /><p className="mt-3 text-2xl font-extrabold">{value}</p><p className="mt-1 text-xs text-[#607066]">{caption}</p></Card>;
}

function ResultCard({ title, value, tone }: { title: string; value: number; tone: "good" | "warning" }) {
  const colours = tone === "good" ? "border-[#cfe1c8] bg-[#eaf4e5] text-[#2e6448]" : "border-[#eadcb9] bg-[#fff7e7] text-[#785f31]";
  return <Card className={`p-5 ${colours}`}><p className="text-4xl font-extrabold">{value.toLocaleString()}</p><p className="mt-1 text-xs font-semibold">{title}</p></Card>;
}

function RecallComparisonChart({ baseline, combined }: { baseline: number; combined: number }) {
  const baselinePercent = Math.max(0, Math.min(100, baseline * 100));
  const combinedPercent = Math.max(0, Math.min(100, combined * 100));
  const improvement = (combined - baseline) * 100;
  const improvementText = `${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)} percentage points`;

  return <Card className="border-[#dce7d8] bg-white p-5" aria-label={`Fraud recall comparison. Baseline ${percent(baseline)}, with proposed rule ${percent(combined)}, improvement ${improvementText}.`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="text-sm font-extrabold text-[#294737]">Fraud recall comparison</h3><p className="mt-1 text-xs text-[#68786e]">Share of fraud-labelled payments detected</p></div>
      <span className="rounded-full bg-[#e8f3e4] px-3 py-1 text-xs font-extrabold text-[#2e6448]">{improvementText}</span>
    </div>
    <div className="mt-5 space-y-4">
      <ChartBar label="Existing controls" value={percent(baseline)} width={baselinePercent} colour="bg-[#789180]" />
      <ChartBar label="With proposed rule" value={percent(combined)} width={combinedPercent} colour="bg-[#32704e]" />
    </div>
    <PercentageAxis />
  </Card>;
}

function DetectionFrictionChart({ fraud, legitimate }: { fraud: number; legitimate: number }) {
  const maximum = Math.max(fraud, legitimate, 1);
  return <Card className="border-[#dce7d8] bg-white p-5" aria-label={`Fraud detection versus customer friction. ${fraud} additional fraud-labelled payments detected and ${legitimate} additional legitimate payments challenged.`}>
    <div><h3 className="text-sm font-extrabold text-[#294737]">Fraud detection versus customer friction</h3><p className="mt-1 text-xs text-[#68786e]">Incremental impact beyond existing controls</p></div>
    <div className="mt-5 space-y-4">
      <ChartBar label="Additional fraud detected" value={fraud.toLocaleString()} width={(fraud / maximum) * 100} colour="bg-[#32704e]" />
      <ChartBar label="Additional legitimate challenged" value={legitimate.toLocaleString()} width={(legitimate / maximum) * 100} colour="bg-[#c38a2d]" />
    </div>
    <div className="mt-2 flex justify-between border-t border-[#dbe4d8] pt-1 text-[10px] text-[#718078]" aria-hidden="true"><span>0</span><span>{maximum.toLocaleString()} payments</span></div>
  </Card>;
}

function ChartBar({ label: caption, value, width, colour }: { label: string; value: string; width: number; colour: string }) {
  return <div><div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs"><span className="font-semibold text-[#4c6254]">{caption}</span><strong className="text-[#294737]">{value}</strong></div><div className="h-4 overflow-hidden rounded-full bg-[#edf1eb]"><div className={`h-full min-w-0 rounded-full ${colour}`} style={{ width: `${Math.max(0, Math.min(100, width))}%` }} /></div></div>;
}

function PercentageAxis() {
  return <div className="mt-2 flex justify-between border-t border-[#dbe4d8] pt-1 text-[10px] text-[#718078]" aria-hidden="true">{[0, 25, 50, 75, 100].map((tick) => <span key={tick}>{tick}%</span>)}</div>;
}

function ScoreCard({ title, score }: { title: string; score: Score }) {
  return <div className="rounded-xl border border-[#e3e9e0] p-4"><h3 className="text-xs font-bold text-[#30483a]">{title}</h3><p className="mt-3">Recall <strong className="float-right">{percent(score.recall)}</strong></p><p className="mt-2">Precision <strong className="float-right">{percent(score.precision)}</strong></p><p className="mt-3 text-[10px] text-[#69786f]">TP {score.truePositives} · FP {score.falsePositives} · FN {score.falseNegatives} · TN {score.trueNegatives}</p></div>;
}

function DecisionBanner({ tone, text, reason }: { tone: "approved" | "rejected"; text: string; reason: string | null }) {
  const colours = tone === "approved" ? "border-[#cde0c5] bg-[#eef6e9] text-[#315f45]" : "border-[#e3d5c4] bg-[#fbf5ed] text-[#755d3c]";
  return <div className={`mt-5 rounded-xl border p-4 text-sm font-semibold ${colours}`}>{text}{reason && <p className="mt-2 text-xs font-normal">Recorded rationale: {reason}</p>}</div>;
}

function Unavailable({ text }: { text: string }) {
  return <p className="rounded-xl bg-[#f6f7f5] p-4 text-sm text-[#68736c]">{text}</p>;
}
