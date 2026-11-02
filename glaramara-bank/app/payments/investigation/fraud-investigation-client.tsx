"use client";

import { AlertTriangle, CheckCircle2, ChevronRight, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  bankingFetch,
  type FraudInvestigation,
  type FraudInvestigationResponse,
} from "@/lib/banking-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function FraudInvestigationClient() {
  const paymentId = useSearchParams().get("paymentId") ?? "";
  const [investigation, setInvestigation] = useState<FraudInvestigation | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentQuestion = useMemo(
    () => investigation?.questions.find((question) => question.id === investigation.currentQuestionId) ?? null,
    [investigation],
  );

  useEffect(() => {
    if (!UUID_PATTERN.test(paymentId)) {
      setError("This security-check link is not valid.");
      setLoaded(true);
      return;
    }
    let cancelled = false;
    bankingFetch<FraudInvestigationResponse>(`/api/v1/payments/${encodeURIComponent(paymentId)}/investigation`)
      .then((response) => { if (!cancelled) setInvestigation(response.investigation); })
      .catch((loadError) => { if (!cancelled) setError(messageFor(loadError)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [paymentId]);

  async function mutate(path: string, body?: unknown, idempotencyKey?: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await bankingFetch<FraudInvestigationResponse>(
        `/api/v1/payments/${encodeURIComponent(paymentId)}/investigation${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      setInvestigation(response.investigation);
    } catch (mutationError) {
      setError(messageFor(mutationError));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <Card className="max-w-[680px] p-6 text-xs text-[#7b8a80] md:p-8">Loading the security check…</Card>;

  if (!investigation) {
    return (
      <Card className="max-w-[680px] p-6 md:p-8">
        <div className="mb-4 grid size-[66px] place-items-center rounded-[20px] bg-[#fff4dc] text-[#8a6421]">
          <ShieldCheck className="size-8" aria-hidden="true" />
        </div>
        <h2 className="text-2xl font-bold tracking-[-.6px]">A quick security check</h2>
        <p className="mt-2 max-w-[560px] text-xs leading-relaxed text-[#59695e]">
          We’ll ask only the questions relevant to this payment. Your answers become evidence for a controlled reassessment; they never override the original fraud decision by themselves.
        </p>
        {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Button disabled={busy || !UUID_PATTERN.test(paymentId)} onClick={() => mutate("") }>
            {busy ? "Starting…" : "Start check"} <ChevronRight className="ml-2 size-4" />
          </Button>
          <Button variant="secondary" asChild><Link href={`/payments/status?paymentId=${encodeURIComponent(paymentId)}`}>Back to payment</Link></Button>
        </div>
      </Card>
    );
  }

  if (investigation.resolution && ["REASSESSED", "FAILED"].includes(investigation.status)) {
    return <ResolutionCard investigation={investigation} busy={busy} error={error} onRetry={() => mutate("/extract")} />;
  }

  if (investigation.status === "READY_FOR_EXTRACTION" || investigation.status === "EXTRACTING") {
    return (
      <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
        <ShieldCheck className="size-9 text-[#275A47]" aria-hidden="true" />
        <h2 className="mt-4 text-2xl font-bold tracking-[-.6px]">Your answers are ready</h2>
        <p className="mt-2 text-xs leading-relaxed text-[#59695e]">
          Fraud Intelligence will interpret the completed questionnaire once, then a separate deterministic policy will choose the simulated resolution.
        </p>
        {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
        <Button className="mt-6" disabled={busy || investigation.status === "EXTRACTING"} onClick={() => mutate("/extract") }>
          {busy || investigation.status === "EXTRACTING" ? "Analysing evidence…" : "Analyse my answers"}
        </Button>
      </Card>
    );
  }

  if (!currentQuestion) {
    return <Card className="max-w-[680px] p-6 text-xs text-[#59695e] md:p-8">The security check is recovering its saved state. Refresh this page.</Card>;
  }

  return (
    <Card className="max-w-[680px] p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <span className="rounded-lg bg-[#edf3e9] px-2.5 py-1.5 text-[10px] font-extrabold tracking-[.05em] text-[#49735b]">SECURITY CHECK</span>
        <span className="text-[11px] text-[#7b8a80]">{investigation.answeredCount + 1} of about {investigation.selectedQuestionCount}</span>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#e7ece4]" aria-hidden="true">
        <div className="h-full rounded-full bg-[#275A47] transition-all" style={{ width: `${Math.max(8, (investigation.answeredCount / investigation.selectedQuestionCount) * 100)}%` }} />
      </div>
      <QuestionForm
        key={currentQuestion.id}
        question={currentQuestion}
        busy={busy}
        onSubmit={(value) => mutate(
          "/answers",
          { questionId: currentQuestion.id, answer: { value } },
          `answer-${investigation.id}-${currentQuestion.id}-${crypto.randomUUID()}`,
        )}
      />
      {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
      <p className="mt-5 text-[10px] leading-relaxed text-[#8a978e]">Don’t enter passwords, security codes or account numbers. Your progress is saved after every answer.</p>
    </Card>
  );
}

function QuestionForm({ question, busy, onSubmit }: {
  question: FraudInvestigation["questions"][number];
  busy: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form className="mt-7" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}>
      <fieldset>
        <legend className="text-xl font-bold leading-snug tracking-[-.4px]">{question.prompt}</legend>
        {question.helpText && <p className="mt-2 text-xs leading-relaxed text-[#59695e]">{question.helpText}</p>}
        {question.kind === "SINGLE_CHOICE" ? (
          <div className="mt-5 grid gap-2.5">
            {question.options?.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#dfe7dc] p-3.5 has-[:checked]:border-[#275A47] has-[:checked]:bg-[#f0f6e9]">
                <input type="radio" name="answer" value={option.value} checked={value === option.value} onChange={() => setValue(option.value)} className="size-4 accent-[#275A47]" />
                <span className="text-sm font-semibold">{option.label}</span>
              </label>
            ))}
          </div>
        ) : (
          <textarea value={value} onChange={(event) => setValue(event.target.value)} maxLength={500} rows={4} className="mt-5 w-full rounded-xl border border-[#dfe7dc] bg-white p-3 text-sm outline-none focus:border-[#275A47] focus:ring-2 focus:ring-[#d6e9b8]" />
        )}
      </fieldset>
      <Button className="mt-5" type="submit" disabled={busy || !value.trim()}>{busy ? "Saving…" : "Save and continue"} <ChevronRight className="ml-2 size-4" /></Button>
    </form>
  );
}

function ResolutionCard({ investigation, busy, error, onRetry }: {
  investigation: FraudInvestigation;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const outcome = investigation.resolution!.outcome;
  const content = outcome === "CLEARED"
    ? { title: "Security check cleared", body: "The controlled policy found complete, low-risk evidence for this simulated payment.", icon: CheckCircle2, colour: "text-[#2f7448] bg-[#e8f5e7]" }
    : outcome === "DECLINED"
      ? { title: "Payment remains declined", body: "The controlled policy found defined fraud or scam indicators. No money has moved.", icon: ShieldX, colour: "text-[#9a403b] bg-[#fbe8e6]" }
      : { title: "Further review is required", body: "The evidence was missing, uncertain, contradictory, or unavailable, so the payment was not cleared.", icon: AlertTriangle, colour: "text-[#8a6421] bg-[#fff4dc]" };
  const Icon = content.icon;
  return (
    <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
      <div className={`grid size-[66px] place-items-center rounded-[20px] ${content.colour}`}><Icon className="size-8" aria-hidden="true" /></div>
      <h2 className="mt-4 text-2xl font-bold tracking-[-.6px]">{content.title}</h2>
      <p className="mt-2 text-xs leading-relaxed text-[#59695e]">{content.body}</p>
      <div className="mt-5 rounded-[11px] border border-[#e3ecd9] bg-[#f0f6e9] p-[14px] text-[11px] leading-relaxed text-[#4f6658]">
        Simulated resolution from {investigation.resolution!.policyVersion}. The original CHALLENGED verdict is immutable; no ledger entry or balance change was made.
      </div>
      {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
      <div className="mt-6 flex flex-wrap gap-2.5">
        {investigation.status === "FAILED" && investigation.canExtract && <Button disabled={busy} onClick={onRetry}><RefreshCw className="mr-2 size-4" />{busy ? "Retrying…" : "Retry once"}</Button>}
        <Button variant="secondary" asChild><Link href={`/payments/status?paymentId=${encodeURIComponent(investigation.paymentId)}`}>View original decision</Link></Button>
        <Button variant="secondary" asChild><Link href="/">Overview</Link></Button>
      </div>
    </Card>
  );
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "The security check is temporarily unavailable.";
}
