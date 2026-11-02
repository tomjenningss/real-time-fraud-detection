"use client";

import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  bankingFetch,
  type Payment,
  type PaymentStatusResponse,
} from "@/lib/banking-api";
import { cn, formatMoney } from "@/lib/utils";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const statusContent = {
  PENDING: {
    badge: "PENDING",
    title: "We’re checking this payment",
    description: "The payment is safely queued while the fraud platform produces its authoritative decision.",
    icon: Clock3,
    colour: "bg-[#edf3e9] text-[#49735b]",
  },
  APPROVED: {
    badge: "APPROVED",
    title: "Payment approved",
    description: "The deterministic fraud policy approved this fictional payment.",
    icon: CheckCircle2,
    colour: "bg-[#e8f5e7] text-[#2f7448]",
  },
  CHALLENGED: {
    badge: "CHALLENGED",
    title: "Payment needs an extra check",
    description: "The deterministic fraud policy selected a challenge. No money has moved.",
    icon: ShieldAlert,
    colour: "bg-[#fff4dc] text-[#8a6421]",
  },
  BLOCKED: {
    badge: "BLOCKED",
    title: "Payment blocked",
    description: "The deterministic fraud policy blocked this fictional payment.",
    icon: ShieldX,
    colour: "bg-[#fbe8e6] text-[#9a403b]",
  },
} as const;

export function PaymentStatusClient() {
  const paymentId = useSearchParams().get("paymentId") ?? "";
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!UUID_PATTERN.test(paymentId)) {
      setError("This payment status link is not valid.");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    async function load() {
      try {
        const response = await bankingFetch<PaymentStatusResponse>(
          `/api/v1/payments/${encodeURIComponent(paymentId)}`,
        );
        if (cancelled) return;
        setPayment(response.payment);
        setError(null);
        polls += 1;
        const shadowFinished = response.payment.experimentalShadow?.status === "EVALUATED";
        const authoritativePending = response.payment.status === "PENDING";
        if (authoritativePending || (!shadowFinished && polls < 80)) {
          timer = setTimeout(load, polls < 80 ? 1_500 : 10_000);
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Payment status is unavailable.");
        polls += 1;
        if (polls < 10) timer = setTimeout(load, 3_000);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [paymentId, refresh]);

  const content = useMemo(
    () => statusContent[payment?.status ?? "PENDING"],
    [payment?.status],
  );
  const Icon = content.icon;

  if (!payment && error) {
    return (
      <Card className="max-w-[680px] p-6 md:p-8">
        <h2 className="text-2xl font-bold tracking-[-.6px]">Payment status unavailable</h2>
        <p className="mt-2 text-xs leading-relaxed text-[#7b8a80]" role="alert">{error}</p>
        <div className="mt-6 flex gap-2.5">
          <Button type="button" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className="mr-2 size-4" /> Try again
          </Button>
          <Button variant="secondary" asChild><Link href="/payments">New payment</Link></Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="max-w-[680px] p-6 md:p-8" aria-live="polite">
      <div className={cn("mb-4 grid size-[66px] place-items-center rounded-[20px]", content.colour)}>
        <Icon className="size-8" aria-hidden="true" />
      </div>
      <div className={cn("mb-2 inline-flex rounded-lg px-2.5 py-[7px] text-[10px] font-extrabold tracking-[.05em]", content.colour)}>
        {content.badge} · DETERMINISTIC POLICY
      </div>
      <h2 className="text-2xl font-bold tracking-[-.6px]">{content.title}</h2>
      <p className="mt-2 max-w-[540px] text-xs leading-relaxed text-[#7b8a80]">
        {content.description}
      </p>

      {payment && (
        <>
          <div className="my-5 rounded-[14px] border border-[#e4eae1] bg-[#fbfdf9] p-4">
            <StatusLine label="Recipient" value={payment.beneficiary.name} />
            <StatusLine label="Amount" value={formatMoney(payment.amount)} />
            <StatusLine label="Reference" value={payment.reference} />
            <StatusLine label="Payment ID" value={payment.id} mono />
          </div>

          {payment.status === "PENDING" && (
            <div className="rounded-[11px] border border-[#e3ecd9] bg-[#f0f6e9] p-[14px] text-[11px] leading-relaxed text-[#617969]">
              {payment.processing.delayed
                ? "Processing is taking longer than usual. The durable outbox will keep retrying safely; this is not an approval or a block."
                : payment.processing.publicationStatus === "PUBLISHED"
                  ? "Kafka accepted the event. Flink enrichment and deterministic policy are still processing it."
                  : "The payment event is in the PostgreSQL outbox and will be retried automatically if Kafka is unavailable."}
            </div>
          )}

          {payment.authoritativeDecision && (
            <div className="rounded-[11px] border border-[#d9ead6] bg-[#f4f9f1] p-[14px] text-[11px] leading-relaxed text-[#55705e]">
              <strong>Authoritative result:</strong> {payment.status} from {payment.authoritativeDecision.policyVersion}. This immutable Python decision alone controls the customer-facing status.
            </div>
          )}

          {payment.status === "CHALLENGED" && (
            <div className="mt-4 rounded-[11px] border border-[#ecd9af] bg-[#fff9ea] p-[14px] text-[11px] leading-relaxed text-[#735c2f]">
              <strong>Help us understand this payment.</strong> Answer a few short questions so Fraud Intelligence can extract evidence for a separate, controlled reassessment. Completing the check does not automatically clear the payment.
              <div className="mt-3">
                <Button asChild>
                  <Link href={`/payments/investigation?paymentId=${encodeURIComponent(payment.id)}`}>
                    Start security check
                  </Link>
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 rounded-[11px] border border-[#e5e8e2] bg-white p-[14px] text-[11px] leading-relaxed text-[#6f7f73]">
            <strong>Experimental shadow evaluation:</strong>{" "}
            {payment.experimentalShadow?.status === "EVALUATED"
              ? `${payment.experimentalShadow.proposedAction} from ${payment.experimentalShadow.policyVersion}`
              : payment.experimentalShadow
                ? `${payment.experimentalShadow.status} under ${payment.experimentalShadow.policyVersion}`
                : "waiting for independent LightGBM evidence and Go correlation"}
            . This evidence cannot change or relax the result above.
            {payment.experimentalShadow?.modelVersion && (
              <> Model: {payment.experimentalShadow.modelVersion}; features: {payment.experimentalShadow.featureSchemaVersion}.</>
            )}
          </div>

          <div className="mt-4 rounded-[11px] border border-[#e3ecd9] bg-[#f0f6e9] p-[14px] text-[11px] leading-relaxed text-[#617969]">
            Simulated payment only. No ledger entry was created and the fictional balance is unchanged.
          </div>
        </>
      )}

      {error && payment && <p className="mt-3 text-[11px] text-[#9a514a]">Latest refresh failed: {error}</p>}
      <div className="mt-6 flex flex-wrap gap-2.5">
        <Button type="button" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw className="mr-2 size-4" /> Refresh status
        </Button>
        <Button variant="secondary" asChild><Link href="/payments">Make another payment</Link></Button>
        <Button variant="secondary" asChild><Link href="/">Overview</Link></Button>
      </div>
    </Card>
  );
}

function StatusLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[#edf0eb] py-2.5 last:border-0">
      <span className="text-xs text-[#7d8d81]">{label}</span>
      <strong className={cn("break-all text-right text-xs", mono && "font-mono text-[10px]")}>{value}</strong>
    </div>
  );
}
