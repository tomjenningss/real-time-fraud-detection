"use client";

import { AlertTriangle, CheckCircle2, FlaskConical, LoaderCircle, Play, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { bankingFetch } from "@/lib/banking-api";
import { formatMoney } from "@/lib/utils";

type ReplayPayment = {
  week: number;
  transactionId: string;
  eventTime: string;
  amount: number;
  processingStatus: "PENDING" | "COMPLETE";
  signals: string[];
  features: null | {
    payments_30d: number;
    cumulative_amount_30d: number;
    successive_growth_count: number;
    successive_pair_count: number;
    current_to_first_amount_ratio: number;
    observed_relationship_age_days: number;
  };
  baseline: { policyVersion: string; verdict: "APPROVED" | "CHALLENGED" | "BLOCKED" | null };
  demo: { policyVersion: string; verdict: "APPROVED" | "CHALLENGED" | "BLOCKED" | null; triggeredRuleIds: string[] };
};

type ReplayRun = {
  runId: string;
  paymentId: string;
  customer: { id: string; name: string };
  beneficiary: { id: string; name: string };
  topics: { raw: string; enriched: string };
  complete: boolean;
  payments: ReplayPayment[];
  isolation: { liveTopicsUntouched: true; ledgerEffect: "NONE"; replayKey: string };
};

export function SlowBuildingDemoClient() {
  const [run, setRun] = useState<ReplayRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || run.complete) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await bankingFetch<ReplayRun>(
          `/api/v1/fraud-operations/slow-building-demo?runId=${encodeURIComponent(run.runId)}`,
        );
        setRun(next);
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Replay status is unavailable.");
      }
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [run]);

  async function startReplay() {
    setBusy(true);
    setError(null);
    try {
      const created = await bankingFetch<{ runId: string }>(
        "/api/v1/fraud-operations/slow-building-demo",
        { method: "POST" },
      );
      setRun(await bankingFetch<ReplayRun>(
        `/api/v1/fraud-operations/slow-building-demo?runId=${encodeURIComponent(created.runId)}`,
      ));
    } catch (replayError) {
      setError(replayError instanceof Error ? replayError.message : "The replay could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function continueAsReplayCustomer(replay: ReplayRun) {
    setHandoffBusy(true);
    setError(null);
    try {
      await bankingFetch("/api/v1/demo/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: replay.customer.id }),
      });
      window.location.assign(
        `/payments/status?paymentId=${encodeURIComponent(replay.paymentId)}`,
      );
    } catch (handoffError) {
      setError(
        handoffError instanceof Error
          ? handoffError.message
          : "The fictional customer session could not be started.",
      );
      setHandoffBusy(false);
    }
  }

  const trigger = run?.payments.find((payment) => payment.signals.includes("SLOW_BUILDING_BENEFICIARY_RISK"));
  return (
    <div className="space-y-5">
      <section className="rounded-[20px] bg-[linear-gradient(130deg,#143b30,#245b47)] p-6 text-white md:p-8">
        <p className="text-[10px] font-extrabold tracking-[.18em] text-[#c9e4d1]">DEVELOPER-ONLY · REAL KAFKA + FLINK REPLAY</p>
        <h1 className="mt-3 text-2xl font-extrabold tracking-[-.7px]">Slow-building investment scam</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#d8eadc]">
          This button creates the entire isolated £200 → £3,000 payment series for you. No real payment,
          beneficiary selection or £5,000 transfer is required. Flink evaluates each event-time arrival
          incrementally; the UI does not manufacture a fraud result.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => void startReplay()} disabled={busy} className="bg-[#d6e9b8] text-[#173f33] hover:bg-[#e4f2cc]">
            {busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
            Replay slow-building investment scam
          </Button>
          <Button variant="secondary" asChild><Link href="/fraud-operations">Back to Fraud Analyst Lab</Link></Button>
        </div>
      </section>

      {error && <div role="alert" className="rounded-xl border border-[#e8caca] bg-[#fff3f2] p-4 text-sm text-[#8c3434]"><AlertTriangle className="mr-2 inline size-4" />{error}</div>}

      <Card className="p-5" aria-label="Independent slow-building rule evaluation">
        <div className="flex items-start gap-3"><FlaskConical className="mt-0.5 size-5 text-[#397052]" /><div>
          <h2 className="text-sm font-extrabold">Independent held-out evaluation</h2>
          <p className="mt-1 text-xs leading-relaxed text-[#66766b]">55 transactions across 12 fraud and legitimate scenarios. Candidate-only precision 66.67%; combined recall rose from 9.38% to 21.88%. The rule found 4 additional fraud-labelled payments and challenged 2 additional legitimate payments.</p>
          <p className="mt-2 text-[11px] text-[#8a6421]">Known friction: escalating family support and an unusual legitimate escalation. This is why the challenge remains isolated and explicitly gated.</p>
        </div></div>
      </Card>

      {run && <>
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-[10px] font-bold tracking-[.12em] text-[#66806e]">REPLAY {run.runId}</p><h2 className="mt-1 text-lg font-extrabold">{run.customer.name} → {run.beneficiary.name}</h2><p className="mt-1 text-xs text-[#5d6f63]">Simulated investment beneficiary only — no customer account balance or ledger is changed.</p></div>
            <div className="rounded-lg bg-[#eef5e9] px-3 py-2 text-[10px] font-bold text-[#376248]">Ledger effect: {run.isolation.ledgerEffect}</div>
          </div>
          <dl className="mt-4 grid gap-2 text-[11px] sm:grid-cols-[max-content_1fr]"><dt className="font-bold">Raw topic</dt><dd className="font-mono">{run.topics.raw}</dd><dt className="font-bold">Enriched topic</dt><dd className="font-mono">{run.topics.enriched}</dd><dt className="font-bold">State key</dt><dd className="break-all font-mono">{run.isolation.replayKey}</dd></dl>
        </Card>

        <div className="space-y-3" aria-live="polite">
          {run.payments.map((payment) => <Card key={payment.transactionId} className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold text-[#758479]">WEEK {payment.week} · {new Date(payment.eventTime).toLocaleDateString("en-GB")}</p><h3 className="mt-1 text-lg font-extrabold">{formatMoney(payment.amount)}</h3></div>{payment.processingStatus === "PENDING" ? <span className="flex items-center text-xs text-[#6d7c72]"><LoaderCircle className="mr-2 size-4 animate-spin" />Waiting for Flink</span> : payment.signals.length ? <span className="flex items-center text-xs font-bold text-[#8a6421]"><ShieldAlert className="mr-2 size-4" />{payment.signals.join(", ")}</span> : <span className="flex items-center text-xs text-[#397052]"><CheckCircle2 className="mr-2 size-4" />No signal</span>}</div>
            {payment.features && <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] md:grid-cols-5"><Feature label="Payments / 30d" value={payment.features.payments_30d} /><Feature label="Exposure / 30d" value={formatMoney(payment.features.cumulative_amount_30d)} /><Feature label="Growth pairs" value={`${payment.features.successive_growth_count}/${payment.features.successive_pair_count}`} /><Feature label="Current ÷ first" value={`${payment.features.current_to_first_amount_ratio}×`} /><Feature label="Observed age" value={`${payment.features.observed_relationship_age_days} days`} /></div>}
            <div className="mt-4 grid gap-2 border-t border-[#e7ece4] pt-4 text-xs md:grid-cols-2"><p><strong>Existing baseline · {payment.baseline.policyVersion}</strong><br />{payment.baseline.verdict ?? "Pending"}</p><p><strong>Gated demo · {payment.demo.policyVersion}</strong><br />{payment.demo.verdict ?? "Pending"}</p></div>
          </Card>)}
        </div>

        {run.complete && <Card className="border-[#d4e3cc] bg-[#f4f9f1] p-5">
          <h2 className="text-sm font-extrabold">Replay complete</h2>
          <p className="mt-2 text-xs leading-relaxed text-[#5d6f63]">
            {trigger
              ? `Payment ${trigger.week} triggered the Flink signal. The existing baseline remained ${trigger.baseline.verdict}; the gated deterministic demo policy returned ${trigger.demo.verdict}.`
              : "No slow-building signal was emitted."}
          </p>
          {trigger?.demo.verdict === "CHALLENGED" && <div className="mt-3 space-y-3">
            <p className="text-xs text-[#5d6f63]">
              No new payment is needed: this replay already created the simulated £3,000 payment to {run.beneficiary.name}.
              Continue as {run.customer.name} to open that payment with questionnaire 1.2.0 and the existing Gemma investigation flow.
            </p>
            <Button onClick={() => void continueAsReplayCustomer(run)} disabled={handoffBusy}>
              {handoffBusy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
              Continue as {run.customer.name}
            </Button>
          </div>}
        </Card>}
      </>}
    </div>
  );
}

function Feature({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-lg bg-[#f4f7f2] p-3"><span className="block text-[9px] font-bold uppercase tracking-[.05em] text-[#78877c]">{label}</span><strong className="mt-1 block text-xs">{value}</strong></div>;
}
