"use client";

import { Plus, X } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

import { useCustomer } from "@/components/customer-provider";
import { DataStateNotice } from "@/components/data-state-notice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { bankingFetch, type BeneficiariesResponse } from "@/lib/banking-api";
import { useBankingResource } from "@/lib/use-banking-resource";

export default function BeneficiariesPage() {
  const { customer, sessionReady } = useCustomer();
  const { data, error, loading, reload } = useBankingResource<BeneficiariesResponse>(
    "/api/v1/beneficiaries",
    customer.id,
    sessionReady,
  );
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function addBeneficiary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setFormError(null);
    try {
      await bankingFetch("/api/v1/beneficiaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.get("displayName"),
          sortCode: form.get("sortCode"),
          accountNumber: form.get("accountNumber"),
        }),
      });
      setAdding(false);
      await reload();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The recipient could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  const beneficiaries = data?.beneficiaries ?? [];

  return (
    <section>
      <DataStateNotice loading={loading} error={error} />
      <div className="mb-[18px] flex items-start justify-between gap-4 sm:items-center">
        <div>
          <h2 className="text-[17px] font-bold tracking-[-.4px]">People and businesses</h2>
          <p className="mt-1 text-xs text-[#89968b]">Fictional recipients attached to this demo account.</p>
        </div>
        <Button variant="secondary" type="button" onClick={() => setAdding((value) => !value)}>
          {adding ? <X className="size-4" /> : <Plus className="size-4" />}
          {adding ? "Cancel" : "Add recipient"}
        </Button>
      </div>

      {adding && (
        <Card className="mb-5 border-[#d7e5d2] p-5">
          <form onSubmit={addBeneficiary} noValidate>
            <h3 className="text-sm font-bold">Add a fictional recipient</h3>
            <p className="mt-1 text-[11px] text-[#7d8d81]">
              This saves a demo beneficiary in PostgreSQL. It cannot move money.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field label="Name" name="displayName" placeholder="Lakeview Property Ltd" maxLength={80} />
              <Field label="Sort code" name="sortCode" placeholder="20-44-83" inputMode="numeric" maxLength={8} />
              <Field
                label="Account number"
                name="accountNumber"
                placeholder="00218459"
                inputMode="numeric"
                maxLength={8}
              />
            </div>
            {formError && (
              <p role="alert" className="mt-3 text-[11px] font-semibold text-[#a64b45]">
                {formError}
              </p>
            )}
            <Button className="mt-4" type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save fictional recipient"}
            </Button>
          </form>
        </Card>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {beneficiaries.map((beneficiary) => (
          <Card key={beneficiary.id} className="flex items-center gap-3 p-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-[#e9f1e6] text-xs font-extrabold text-[#37714c]">
              {beneficiary.initials}
            </div>
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-xs font-bold">{beneficiary.name}</strong>
              <small className="mt-1 block text-[10px] text-[#93a095]">
                {beneficiary.recent ? "Paid before" : "New beneficiary"} · •••• {beneficiary.accountNumber.slice(-4)}
              </small>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/payments?beneficiary=${beneficiary.id}`}>Pay →</Link>
            </Button>
          </Card>
        ))}
        {!loading && !error && beneficiaries.length === 0 && (
          <Card className="p-6 text-center text-xs text-[#839589]">No fictional beneficiaries yet.</Card>
        )}
      </div>

    </section>
  );
}

function Field({ label, name, ...props }: React.ComponentProps<typeof Input> & { label: string; name: string }) {
  return (
    <label className="text-[11px] font-bold text-[#596a5e]">
      {label}
      <Input className="mt-2" name={name} required {...props} />
    </label>
  );
}
