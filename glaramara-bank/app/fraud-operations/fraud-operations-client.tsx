"use client";

import { AlertTriangle, BrainCircuit, CheckCircle2, Clock3, Database, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { bankingFetch } from "@/lib/banking-api";

type RunSummary = {
  id: string; status: string; snapshotRowCount: number; startedAt: string; finishedAt: string | null;
  candidateId: string | null; ruleName: string | null; candidateStatus: string | null;
};
type Dashboard = {
  synthetic: true;
  dataset: { totalTransactions: number; fraudLabelled: number; baselineFraudDetected: number; baselineCoverage: number };
  waves: Array<{ id: string; rowCount: number; discoveryCount: number; evaluationCount: number; seed: number; contentSha256: string }>;
  runs: RunSummary[];
};
type Proposal = {
  name: string; description: string; rationale: string; action: string; uncertainty: string;
  conditions: Array<{ featureId: string; operator: string; threshold: number; window: string | null }>;
  supportingEvidenceRefs: string[]; limitations: string[];
};
type Metrics = {
  baseline: Score; candidate: Score; combined: Score;
  additionalFraudDetected: number; additionalLegitimateChallenged: number; overlapWithBaseline: number;
};
type Score = { truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number; precision: number; recall: number };
type RunDetail = {
  id: string; status: string; snapshot: unknown; snapshotSha256: string; snapshotRowCount: number; errorType: string | null;
  agent: { provider: string; model: string; agentId: string; latencyMs: number } | null;
  candidate: null | {
    id: string; fingerprint: string; duplicateOfCandidateId: string | null; status: string; proposal: Proposal;
    backtest: null | { evaluatorVersion: string; metrics: Metrics; examples: { additionalFraud: string[]; falsePositives: string[]; overlap: string[] }; semanticsNote: string };
    review: null | { decision: string; reason: string | null; reviewedAt: string };
  };
};

function percent(value: number) { return `${(value * 100).toFixed(1)}%`; }
function label(value: string) { return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function FraudOperationsClient() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const refresh = useCallback(async () => {
    const data = await bankingFetch<Dashboard>("/api/v1/fraud-operations");
    setDashboard(data);
  }, []);
  useEffect(() => { refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Dashboard unavailable.")); }, [refresh]);

  async function loadRun(runId: string) {
    setError(null);
    const response = await bankingFetch<{ run: RunDetail }>(`/api/v1/fraud-operations/runs/${runId}`);
    setRun(response.run);
  }

  async function analyse() {
    setBusy(true); setError(null);
    try {
      const response = await bankingFetch<{ run: RunDetail }>("/api/v1/fraud-operations/analyses", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setRun(response.run);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pattern analysis failed.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function review(decision: "APPROVED_FOR_IMPLEMENTATION" | "REJECTED") {
    if (!run?.candidate) return;
    setBusy(true); setError(null);
    try {
      const response = await bankingFetch<{ run: RunDetail }>(
        `/api/v1/fraud-operations/candidates/${run.candidate.id}/reviews`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, reason: reason || undefined }) },
      );
      setRun(response.run); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be recorded."); }
    finally { setBusy(false); }
  }

  const data = dashboard?.dataset;
  const metrics = run?.candidate?.backtest?.metrics;
  return (
    <div className="space-y-5">
      <section className="rounded-[20px] bg-[linear-gradient(130deg,#13392e,#205543_65%,#295e4a)] p-6 text-white shadow-[0_16px_30px_rgba(23,63,51,.14)] md:p-8">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div className="max-w-2xl">
            <p className="text-[10px] font-extrabold tracking-[.18em] text-[#c9e4d1]">SYNTHETIC FRAUD LAB · HUMAN APPROVAL REQUIRED</p>
            <h2 className="mt-3 text-2xl font-extrabold tracking-[-.8px] md:text-3xl">Discover emerging fraud patterns</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#d8eadc]">Watsonx Orchestrate analyses bounded discovery evidence. Glaramara validates and independently backtests every proposal.</p>
          </div>
          <Button onClick={() => void analyse()} disabled={busy || !dashboard?.waves.length} className="min-w-[210px] bg-[#d6e9b8] text-[#173f33] hover:bg-[#e4f2cc]">
            <BrainCircuit className="mr-2 size-4" />{busy ? "Analysing patterns…" : "Analyse fraud patterns"}
          </Button>
        </div>
      </section>

      {error && <div role="alert" className="rounded-xl border border-[#e8caca] bg-[#fff3f2] p-4 text-sm text-[#8c3434]"><AlertTriangle className="mr-2 inline size-4" />{error}</div>}
      {busy && <div role="status" className="rounded-xl border border-[#d7e4cf] bg-white p-4 text-sm text-[#49644f]">Creating an immutable snapshot, invoking the agent and running the held-out backtest. This can take up to a minute.</div>}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Database} label="Current active dataset" value={data ? `${data.totalTransactions.toLocaleString()} transactions` : "—"} />
        <Metric icon={AlertTriangle} label="Fraud-labelled cases" value={data?.fraudLabelled.toLocaleString() ?? "—"} />
        <Metric icon={ShieldCheck} label="Existing rule coverage" value={data ? percent(data.baselineCoverage) : "—"} />
        <Metric icon={Clock3} label="Immutable waves" value={dashboard?.waves.length.toString() ?? "—"} />
      </section>

      {run?.candidate && (
        <section className="space-y-4" aria-label="Candidate rule detail">
          <div className="rounded-xl border border-[#d8e4d4] bg-[#f7faf5] px-4 py-3 text-xs text-[#4c6655]">
            <strong>Historical analysis snapshot:</strong> {run.snapshotRowCount.toLocaleString()} transactions · Snapshot {run.snapshotSha256.slice(0, 12)}…
            {data && data.totalTransactions !== run.snapshotRowCount && (
              <span> · Current active dataset: {data.totalTransactions.toLocaleString()} transactions</span>
            )}
          </div>
          <Card className="p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="text-[10px] font-extrabold tracking-[.14em] text-[#50705c]">{label(run.candidate.status)}</p><h2 className="mt-1 text-xl font-extrabold">{run.candidate.proposal.name}</h2></div>
              <span className="rounded-full bg-[#e6f0df] px-3 py-1 text-xs font-bold text-[#315f45]">Action: {run.candidate.proposal.action}</span>
            </div>
            {run.candidate.duplicateOfCandidateId && <p className="mt-3 rounded-lg bg-[#fff8e8] p-3 text-xs text-[#765e2d]">Exact duplicate of candidate {run.candidate.duplicateOfCandidateId}.</p>}
            <p className="mt-4 text-sm leading-relaxed text-[#52675a]">{run.candidate.proposal.description}</p>
            <p className="mt-3 text-sm leading-relaxed"><strong>AI rationale:</strong> {run.candidate.proposal.rationale}</p>
            <div className="mt-5 grid gap-2 md:grid-cols-2">
              {run.candidate.proposal.conditions.map((condition) => <div key={`${condition.featureId}:${condition.window}:${condition.threshold}`} className="rounded-xl border border-[#e1e9de] bg-[#f8faf6] p-3 text-xs"><strong>{label(condition.featureId)}</strong><br />{condition.operator} {condition.threshold.toLocaleString()} {condition.window ?? ""}</div>)}
            </div>
          </Card>
          {metrics && <div className="grid gap-4 md:grid-cols-3">
            <ResultCard title="Additional fraud detected" value={metrics.additionalFraudDetected} tone="good" />
            <ResultCard title="Additional genuine challenged" value={metrics.additionalLegitimateChallenged} tone="warning" />
            <ResultCard title="Existing control overlap" value={metrics.overlapWithBaseline} tone="neutral" />
            <ScoreCard title="Existing baseline" score={metrics.baseline} />
            <ScoreCard title="Candidate alone" score={metrics.candidate} />
            <ScoreCard title="Baseline + candidate" score={metrics.combined} />
          </div>}
          {run.candidate.backtest && <Card className="p-5 text-xs leading-relaxed text-[#52675a]"><strong>Evaluation provenance:</strong> {run.snapshotRowCount.toLocaleString()} snapshot transactions · {run.candidate.backtest.evaluatorVersion} · {run.candidate.backtest.semanticsNote}<br /><strong>Agent:</strong> {run.agent?.provider} · {run.agent?.model} · {run.agent?.latencyMs.toLocaleString()} ms<br /><strong>False-positive examples:</strong> {run.candidate.backtest.examples.falsePositives.join(", ") || "None"}</Card>}
          {!run.candidate.review && run.candidate.status === "BACKTESTED" && <Card className="p-5">
            <label htmlFor="review-reason" className="text-xs font-bold">Optional review reason</label>
            <textarea id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} className="mt-2 min-h-20 w-full rounded-xl border border-[#dce5d9] p-3 text-sm outline-none focus:ring-2 focus:ring-[#6b9d73]" />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row"><Button disabled={busy} onClick={() => void review("APPROVED_FOR_IMPLEMENTATION")}><CheckCircle2 className="mr-2 size-4" />Approve for implementation</Button><Button disabled={busy} variant="outline" onClick={() => void review("REJECTED")}><XCircle className="mr-2 size-4" />Reject proposal</Button></div>
          </Card>}
          {run.candidate.review?.decision === "APPROVED_FOR_IMPLEMENTATION" && <div className="rounded-xl border border-[#cde0c5] bg-[#eef6e9] p-4 text-sm font-semibold text-[#315f45]">Rule approved for future implementation. No live fraud detection controls have been changed.</div>}
          {run.candidate.review?.decision === "REJECTED" && <div className="rounded-xl border border-[#e3d5c4] bg-[#fbf5ed] p-4 text-sm font-semibold text-[#755d3c]">Proposal rejected. No live fraud detection controls have been changed.</div>}
        </section>
      )}

      <Card className="p-5"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-bold">Analysis history</h2><p className="text-[10px] text-[#68786e]">Current active dataset: {data?.totalTransactions.toLocaleString() ?? "—"} transactions</p></div><div className="mt-3 divide-y divide-[#e7ece5]">{dashboard?.runs.length ? dashboard.runs.map((item) => <button type="button" key={item.id} onClick={() => void loadRun(item.id)} className="flex w-full items-center justify-between gap-3 py-3 text-left text-xs hover:text-[#276144]"><span><strong>{item.ruleName ?? "Analysis run"}</strong><br /><span className="text-[#68786e]">{new Date(item.startedAt).toLocaleString()} · Historical snapshot: {item.snapshotRowCount.toLocaleString()} transactions</span></span><span className="font-bold">{label(item.candidateStatus ?? item.status)} →</span></button>) : <p className="py-3 text-xs text-[#68786e]">No analyses have been run yet.</p>}</div></Card>
    </div>
  );
}

function Metric({ icon: Icon, label: caption, value }: { icon: typeof Database; label: string; value: string }) { return <Card className="p-5"><Icon className="size-5 text-[#3f7858]" /><p className="mt-3 text-2xl font-extrabold">{value}</p><p className="mt-1 text-xs text-[#607066]">{caption}</p></Card>; }
function ResultCard({ title, value, tone }: { title: string; value: number; tone: "good" | "warning" | "neutral" }) { const colours = { good: "bg-[#eaf4e5] text-[#2e6448]", warning: "bg-[#fff7e7] text-[#785f31]", neutral: "bg-white text-[#30483a]" }; return <Card className={`p-5 ${colours[tone]}`}><p className="text-3xl font-extrabold">{value}</p><p className="mt-1 text-xs font-semibold">{title}</p></Card>; }
function ScoreCard({ title, score }: { title: string; score: Score }) { return <Card className="p-5"><h3 className="text-sm font-bold">{title}</h3><p className="mt-3 text-xs">Recall <strong className="float-right">{percent(score.recall)}</strong></p><p className="mt-2 text-xs">Precision <strong className="float-right">{percent(score.precision)}</strong></p><p className="mt-2 text-[10px] text-[#69786f]">TP {score.truePositives} · FP {score.falsePositives} · FN {score.falseNegatives} · TN {score.trueNegatives}</p></Card>; }
