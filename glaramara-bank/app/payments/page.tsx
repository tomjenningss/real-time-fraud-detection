"use client";

import { CheckCircle2, LoaderCircle, ShieldCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";

import { useCustomer } from "@/components/customer-provider";
import { DataStateNotice } from "@/components/data-state-notice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  bankingFetch,
  type BeneficiariesResponse,
  type PaymentSubmissionResponse,
} from "@/lib/banking-api";
import type { Beneficiary } from "@/lib/demo-data";
import { useBankingResource } from "@/lib/use-banking-resource";
import { cn } from "@/lib/utils";

type Step = "recipient" | "amount" | "review";

const stepIndex: Record<Step, number> = {
  recipient: 1,
  amount: 2,
  review: 3,
};

export default function PaymentsPage() {
  return (
    <Suspense fallback={<DataStateNotice loading error={null} />}>
      <PaymentJourney />
    </Suspense>
  );
}

function PaymentJourney() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedBeneficiaryId = searchParams.get("beneficiary");
  const { customer, sessionReady } = useCustomer();
  const { data, error: beneficiariesError, loading } = useBankingResource<BeneficiariesResponse>(
    "/api/v1/beneficiaries",
    customer.id,
    sessionReady,
  );
  const beneficiaries = data?.beneficiaries ?? [];
  const [step, setStep] = useState<Step>("recipient");
  const [recipient, setRecipient] = useState<Beneficiary | null>(null);
  const [amount, setAmount] = useState("10000");
  const [reference, setReference] = useState("Property deposit");
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const numericAmount = Number(amount);
  useEffect(() => {
    setStep("recipient");
    setRecipient(null);
    setIdempotencyKey(null);
    setSubmitting(false);
    setError(null);
  }, [customer.id]);

  useEffect(() => {
    if (!requestedBeneficiaryId || !data) return;
    const requestedRecipient = data.beneficiaries.find(
      (beneficiary) => beneficiary.id === requestedBeneficiaryId,
    );
    if (!requestedRecipient) return;
    setRecipient(requestedRecipient);
    setStep("amount");
  }, [data, requestedBeneficiaryId]);

  function changeRecipient() {
    setStep("recipient");
    setRecipient(null);
    setIdempotencyKey(null);
    setError(null);
    router.replace("/payments");
  }

  function continueFromAmount(event: FormEvent) {
    event.preventDefault();
    if (!Number.isFinite(numericAmount) || numericAmount < 0.01 || numericAmount > 1_000_000) {
      setError("Enter an amount between £0.01 and £1,000,000.00.");
      return;
    }
    if (!reference.trim()) {
      setError("Add a payment reference.");
      return;
    }
    setError(null);
    setStep("review");
  }

  async function submitPayment() {
    if (!recipient || submitting) return;
    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    setSubmitting(true);
    setError(null);
    try {
      const result = await bankingFetch<PaymentSubmissionResponse>("/api/v1/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          beneficiaryId: recipient.id,
          amount: numericAmount.toFixed(2),
          reference: reference.trim(),
        }),
      });
      router.push(`/payments/status?paymentId=${encodeURIComponent(result.payment.id)}`);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The fictional payment could not be submitted. You can safely try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <section>
      <DataStateNotice loading={loading} error={beneficiariesError} />
      <div className="mb-[18px] flex items-start justify-between gap-4 sm:items-center">
        <div>
          <h2 className="text-[17px] font-bold tracking-[-.4px]">Make a payment</h2>
          <p className="mt-1 text-xs text-[#89968b]">Secure, simple and designed with care.</p>
        </div>
        <Button variant="secondary" asChild>
          <Link href="/">← Overview</Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="p-5 md:p-[25px]">
          <div className="mb-[21px] flex gap-2" aria-label={`Payment step ${stepIndex[step]} of 4`}>
            {[1, 2, 3, 4].map((item) => (
              <span
                key={item}
                className={cn(
                  "h-[5px] flex-1 rounded-full bg-[#e9ede6]",
                  item <= stepIndex[step] && "bg-[#3d785a]",
                )}
              />
            ))}
          </div>

          {step === "recipient" && (
            <div>
              <h2 className="text-[21px] font-bold tracking-[-.8px] md:text-[23px]">Who are you paying?</h2>
              <p className="mb-[22px] mt-1 text-xs leading-relaxed text-[#859288]">
                Choose a fictional beneficiary already attached to this demo account.
              </p>
              <fieldset className="space-y-2.5">
                <legend className="sr-only">Choose a beneficiary</legend>
                {beneficiaries.map((item) => {
                  const selected = recipient?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setRecipient(item)}
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[13px] border border-[#e6ebe3] bg-white px-[15px] py-[13px] text-left transition hover:border-[#78a481] hover:bg-[#f6faf4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6b9d73]",
                        selected && "border-[#78a481] bg-[#f6faf4]",
                      )}
                    >
                      <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-[#e9f1e6] text-[13px] font-bold text-[#37714c]">
                        {item.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-xs">{item.name}</strong>
                        <small className="mt-1 block text-[10px] text-[#93a095]">
                          {item.recent ? "Paid before" : "New beneficiary"} · •••• {item.accountNumber.slice(-4)}
                        </small>
                      </span>
                      <span className="text-[#398452]" aria-hidden="true">
                        {selected ? <CheckCircle2 className="size-[19px]" /> : "›"}
                      </span>
                    </button>
                  );
                })}
                {!loading && !beneficiariesError && beneficiaries.length === 0 && (
                  <p className="rounded-xl border border-[#e6ebe3] p-4 text-xs text-[#7b8a80]">
                    Add a fictional beneficiary before reviewing a payment.
                  </p>
                )}
              </fieldset>
              <Link
                href="/beneficiaries"
                className="mt-2.5 flex w-full items-center gap-3 rounded-[13px] border border-dashed border-[#bdd3bd] bg-[#f6fbf5] px-[15px] py-[13px] text-left text-[#34684c]"
              >
                <span className="grid size-10 place-items-center rounded-[14px] bg-[#e3efdf]">
                  <UserPlus className="size-[18px]" />
                </span>
                <span className="flex-1">
                  <strong className="block text-xs">Manage beneficiaries</strong>
                  <small className="mt-1 block text-[10px] text-[#789282]">Add someone through the banking API</small>
                </span>
                →
              </Link>
              <Button className="mt-6 w-full" disabled={!recipient} onClick={() => setStep("amount")}>
                Continue →
              </Button>
            </div>
          )}

          {step === "amount" && recipient && (
            <form onSubmit={continueFromAmount} noValidate>
              <h2 className="text-[21px] font-bold tracking-[-.8px] md:text-[23px]">How much?</h2>
              <p className="mb-[22px] mt-1 text-xs leading-relaxed text-[#859288]">
                Enter the amount and reference for <strong>{recipient.name}</strong>.
              </p>
              <label className="my-[18px] flex items-center justify-center rounded-[15px] border border-[#dfe8db] bg-[#fbfdf9] px-3 py-[18px] focus-within:border-[#6b9d73] focus-within:ring-4 focus-within:ring-[#468147]/[.07]">
                <span className="text-[34px] font-semibold text-[#55715c]">£</span>
                <span className="sr-only">Amount in pounds</span>
                <input
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="w-3/4 min-w-20 max-w-[260px] border-0 bg-transparent text-center text-[34px] font-extrabold tracking-[-1.8px] text-[#1a3d2e] outline-none md:text-[40px]"
                />
              </label>
              <label htmlFor="reference" className="mb-2 mt-[18px] block text-[11px] font-bold text-[#596a5e]">
                Payment reference
              </label>
              <Input
                id="reference"
                value={reference}
                maxLength={24}
                onChange={(event) => setReference(event.target.value)}
              />
              {error && (
                <p className="mt-2 text-[11px] font-semibold text-[#a64b45]" role="alert">
                  {error}
                </p>
              )}
              <div className="mt-6 flex gap-2.5">
                <Button variant="secondary" type="button" onClick={changeRecipient}>
                  Change recipient
                </Button>
                <Button type="submit" className="flex-1">
                  Review payment →
                </Button>
              </div>
            </form>
          )}

          {step === "review" && recipient && (
            <div>
              <h2 className="text-[21px] font-bold tracking-[-.8px] md:text-[23px]">One last look</h2>
              <p className="mb-[22px] mt-1 text-xs leading-relaxed text-[#859288]">
                Check the payment details before continuing.
              </p>
              <div className="my-[18px] flex items-center justify-center rounded-[15px] border border-[#dfe8db] bg-[#fbfdf9] px-3 py-[18px]">
                <span className="text-[34px] font-semibold text-[#55715c]">£</span>
                <span className="text-[34px] font-extrabold tracking-[-1.8px] text-[#1a3d2e] md:text-[40px]">
                  {numericAmount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <ReviewLine label="Recipient" value={recipient.name} />
              <ReviewLine label="Sort code" value={recipient.sortCode} />
              <ReviewLine label="Account" value={`•••• ${recipient.accountNumber.slice(-4)}`} />
              <ReviewLine label="Reference" value={reference.trim()} />
              <div className="my-5 h-px bg-[#e7ebe5]" />
              {error && (
                <p className="mt-2 text-[11px] font-semibold text-[#a64b45]" role="alert">
                  {error}
                </p>
              )}
              <div className="mt-6 flex gap-2.5">
                <Button variant="secondary" type="button" disabled={submitting} onClick={() => setStep("amount")}>
                  ← Back
                </Button>
                <Button type="button" className="flex-1" disabled={submitting} onClick={submitPayment}>
                  {submitting ? (
                    <><LoaderCircle className="mr-2 size-4 animate-spin" /> Submitting securely…</>
                  ) : (
                    "Send payment"
                  )}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <aside className="hidden rounded-[18px] border border-[#e7ebe5] bg-white p-[22px] shadow-soft lg:block">
          <div className="grid size-[35px] place-items-center rounded-xl bg-[#e7f2e4] text-[#34754c]">
            <ShieldCheck className="size-[18px]" aria-hidden="true" />
          </div>
          <h3 className="mb-2 mt-[14px] text-sm font-bold tracking-[-.3px]">Payment protection</h3>
          <p className="text-xs leading-relaxed text-[#849287]">We’ll help you spot anything that doesn’t look quite right.</p>
          {[
            "Check the recipient details carefully",
            "Never share a password or security code",
            "Pause if someone is pressuring you to pay",
          ].map((label) => (
            <div key={label} className="flex items-start gap-2 border-t border-[#e7ebe5] py-3 text-[11px] leading-normal text-[#77877a]">
              <span>✳</span> {label}
            </div>
          ))}
        </aside>
      </div>
    </section>
  );
}

function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 py-2.5 text-xs">
      <span className="text-[#7d8d81]">{label}</span>
      <strong className="text-right">{value}</strong>
    </div>
  );
}
