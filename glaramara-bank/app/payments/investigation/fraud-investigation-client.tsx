"use client";

import { AlertTriangle, CheckCircle2, ChevronRight, Headphones, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

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
  const [reviewElapsedMs, setReviewElapsedMs] = useState(0);
  const automaticRequest = useRef<string | null>(null);
  const recoveryRequestAt = useRef(0);
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

  useEffect(() => {
    if (investigation?.status !== "READY_FOR_EXTRACTION") return;
    const requestKey = `${investigation.id}:${investigation.agentInvocationCount}`;
    if (automaticRequest.current === requestKey) return;
    automaticRequest.current = requestKey;
    void mutate("/extract");
  }, [investigation?.agentInvocationCount, investigation?.id, investigation?.status]);

  useEffect(() => {
    if (investigation?.status !== "EXTRACTING") {
      setReviewElapsedMs(0);
      return;
    }
    let cancelled = false;
    const startedAt = new Date(investigation.lifecycleUpdatedAt).getTime();
    const poll = async () => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      setReviewElapsedMs(elapsedMs);
      try {
        const response = await bankingFetch<FraudInvestigationResponse>(
          `/api/v1/payments/${encodeURIComponent(paymentId)}/investigation`,
        );
        if (!cancelled) {
          setInvestigation(response.investigation);
          setError(null);
        }
      } catch (pollError) {
        if (!cancelled) setError(messageFor(pollError));
      }
      if (elapsedMs >= 65_000 && Date.now() - recoveryRequestAt.current >= 15_000) {
        recoveryRequestAt.current = Date.now();
        void mutate("/extract");
      }
    };
    const interval = window.setInterval(() => { void poll(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [investigation?.lifecycleUpdatedAt, investigation?.status, paymentId]);

  async function mutate(path: string, body?: unknown, idempotencyKey?: string) {
    const previousInvestigation = investigation;
    const isFinalSelectedAnswer = path === "/answers"
      && investigation !== null
      && investigation.answeredCount + 1 >= investigation.selectedQuestionCount;
    setBusy(true);
    setError(null);
    if (path === "/extract" || isFinalSelectedAnswer) {
      setInvestigation((current) => current ? {
        ...current,
        status: "EXTRACTING",
        reassessmentLifecycle: "PROCESSING",
        lifecycleUpdatedAt: new Date().toISOString(),
      } : current);
    }
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
      if (path === "/extract") automaticRequest.current = null;
      if (isFinalSelectedAnswer) setInvestigation(previousInvestigation);
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
          We’ll ask only the questions relevant to this payment. The payment has not been sent while we complete these checks.
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

  if (investigation.status === "FAILED") {
    return <FailureCard investigation={investigation} busy={busy} error={error} onRetry={() => mutate("/extract")} />;
  }

  if (investigation.status === "READY_FOR_EXTRACTION" || investigation.status === "EXTRACTING") {
    return (
      <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
        <div className="grid size-[66px] place-items-center rounded-[20px] bg-[#edf3e9] text-[#275A47]">
          <RefreshCw className="size-8 animate-spin" aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-[-.6px]">We’re reviewing your payment</h2>
        <p className="mt-2 max-w-[560px] text-xs leading-relaxed text-[#59695e]">
          Thanks — we’ve saved your answers. We’re carrying out a few final checks and this page will update automatically.
        </p>
        {reviewElapsedMs >= 15_000 && (
          <div className="mt-5 rounded-[11px] border border-[#eadfbe] bg-[#fff8e8] p-[14px] text-[11px] leading-relaxed text-[#755b26]">
            This is taking a little longer than usual. You can keep this page open or come back later; your progress is safely saved.
          </div>
        )}
        {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
        <p className="mt-6 text-[10px] leading-relaxed text-[#8a978e]">Please don’t make the payment again while we finish these checks.</p>
      </Card>
    );
  }

  if (investigation.resolution && investigation.status === "REASSESSED") {
    return <ResolutionCard investigation={investigation} />;
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

function ResolutionCard({ investigation }: {
  investigation: FraudInvestigation;
}) {
  const [reviewRequested, setReviewRequested] = useState(false);
  const resolution = investigation.resolution!;
  const outcome = resolution.outcome;
  const guidance = resolution.guidance;
  const fallback = outcome === "ADDITIONAL_VERIFICATION"
    ? {
        title: "We need to verify the beneficiary",
          body: "We need to verify the beneficiary before this payment can continue. The payment has not been sent.",
        icon: ShieldCheck,
        colour: "text-[#2f7448] bg-[#e8f5e7]",
      }
    : outcome === "CLEARED"
    ? { title: "Security check complete", body: "This payment passed our additional security checks.", icon: CheckCircle2, colour: "text-[#2f7448] bg-[#e8f5e7]" }
    : outcome === "DECLINED"
      ? {
          title: "We’ve stopped this payment to help keep your money safe",
          body: "We stopped this payment. No money was sent. End any unexpected contact and check the request another way.",
          icon: ShieldX,
          colour: "text-[#9a403b] bg-[#fbe8e6]",
        }
      : outcome === "REFER_TO_ANALYST"
        ? { title: "We need to review this further", body: "We couldn’t complete enough checks to approve this payment. It has not been sent.", icon: AlertTriangle, colour: "text-[#8a6421] bg-[#fff4dc]" }
        : { title: "We need to keep this payment on hold", body: "We couldn’t complete enough checks to approve this payment. No money has left your account.", icon: AlertTriangle, colour: "text-[#8a6421] bg-[#fff4dc]" };
  const Icon = outcome === "DECLINED" ? ShieldX : fallback.icon;
  const colour = outcome === "DECLINED" ? "text-[#9a403b] bg-[#fbe8e6]" : fallback.colour;
  return (
    <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
      <div className={`grid size-[66px] place-items-center rounded-[20px] ${colour}`}><Icon className="size-8" aria-hidden="true" /></div>
      <h2 className="mt-4 text-2xl font-bold tracking-[-.6px]">{outcome === "DECLINED" ? fallback.title : guidance?.rendered.heading ?? fallback.title}</h2>
      {guidance?.customerStatement && (
        <div className="mt-4 rounded-xl border border-[#dfe8dc] bg-[#f8fbf6] p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[.1em] text-[#4f6658]">What you told us</p>
          <blockquote className="mt-2 border-l-2 border-[#78a86e] pl-3 text-xs font-semibold leading-relaxed text-[#294b3a]">
            “{guidance.customerStatement}”
          </blockquote>
        </div>
      )}
      <p className="mt-4 text-sm leading-relaxed text-[#405b4b]">{guidance?.rendered.context ?? fallback.body}</p>
      {guidance && (
        <ol className="mt-5 space-y-3">
          {guidance.rendered.steps.map((step, index) => (
            <li className="flex gap-3 text-sm leading-relaxed text-[#294b3a]" key={step}>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#e7f1df] text-[11px] font-extrabold text-[#36684b]">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      {guidance && (
        <div className="mt-5 rounded-xl border border-[#eadfbd] bg-[#fff9e9] p-4 text-xs leading-relaxed text-[#66542d]">
          <strong className="block text-[#55451f]">Payment status</strong>
          <span className="mt-1 block">{guidance.rendered.paymentStatus}</span>
        </div>
      )}
      {outcome !== "CLEARED" && (
        <section className="mt-5 rounded-xl border border-[#dfe5dc] bg-[#fbfcfa] p-4" aria-labelledby="specialist-review-heading">
          <h3 id="specialist-review-heading" className="text-sm font-bold text-[#243f33]">Think this payment is genuine?</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-[#647269]">If you’ve independently checked the request, you can ask for a specialist review.</p>
          <Button className="mt-3 w-full" variant="secondary" type="button" disabled={reviewRequested} onClick={() => setReviewRequested(true)}>
            <Headphones className="mr-2 size-4" aria-hidden="true" />
            {reviewRequested ? "Review request noted" : "Request a fraud specialist review"}
          </Button>
          {reviewRequested ? (
            <p className="mt-3 text-[11px] leading-relaxed text-[#53695b]" role="status">Demo acknowledgement: your request has been noted on this page only. No fraud specialist has been contacted and nothing has been stored.</p>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-[#7a867e]">This demonstration is not connected to a specialist review service.</p>
          )}
        </section>
      )}
      <div className="mt-6 flex flex-wrap gap-2.5">
        <Button variant="secondary" asChild><Link href={`/payments/status?paymentId=${encodeURIComponent(investigation.paymentId)}`}>View payment</Link></Button>
        <Button variant="secondary" asChild><Link href="/">Overview</Link></Button>
      </div>
    </Card>
  );
}

function FailureCard({ investigation, busy, error, onRetry }: {
  investigation: FraudInvestigation;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
      <div className="grid size-[66px] place-items-center rounded-[20px] bg-[#fff4dc] text-[#8a6421]">
        <AlertTriangle className="size-8" aria-hidden="true" />
      </div>
      <h2 className="mt-4 text-2xl font-bold tracking-[-.6px]">We couldn’t finish the review</h2>
      <p className="mt-2 text-xs leading-relaxed text-[#59695e]">
        Your payment has not been approved and no money has moved. Your answers are saved, so you can safely try the review again.
      </p>
      {error && <p className="mt-4 text-xs text-[#9a403b]" role="alert">{error}</p>}
      <div className="mt-6 flex flex-wrap gap-2.5">
        {investigation.canExtract && (
          <Button disabled={busy} onClick={onRetry}>
            <RefreshCw className="mr-2 size-4" />{busy ? "Trying again…" : "Try again"}
          </Button>
        )}
        <Button variant="secondary" asChild><Link href={`/payments/status?paymentId=${encodeURIComponent(investigation.paymentId)}`}>View payment</Link></Button>
      </div>
    </Card>
  );
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "The security check is temporarily unavailable.";
}
