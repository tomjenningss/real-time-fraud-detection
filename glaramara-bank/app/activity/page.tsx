"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { useCustomer } from "@/components/customer-provider";
import { DataStateNotice } from "@/components/data-state-notice";
import { TransactionList } from "@/components/transaction-list";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ActivityResponse } from "@/lib/banking-api";
import { useBankingResource } from "@/lib/use-banking-resource";

export default function ActivityPage() {
  const [query, setQuery] = useState("");
  const { customer, sessionReady } = useCustomer();
  const { data, error, loading } = useBankingResource<ActivityResponse>(
    "/api/v1/activity",
    customer.id,
    sessionReady,
  );
  const transactions = data?.transactions ?? [];
  const filtered = useMemo(() => {
    const normalised = query.trim().toLocaleLowerCase("en-GB");
    if (!normalised) return transactions;
    return transactions.filter((item) =>
      `${item.name} ${item.date}`.toLocaleLowerCase("en-GB").includes(normalised),
    );
  }, [query, transactions]);

  return (
    <section>
      <DataStateNotice loading={loading} error={error} />
      <div className="mb-[18px] flex items-start justify-between gap-4 sm:items-center">
        <div>
          <h2 className="text-[17px] font-bold tracking-[-.4px]">Your transactions</h2>
          <p className="mt-1 text-xs text-[#89968b]">A clear view of where your money goes.</p>
        </div>
        <Button variant="secondary" asChild>
          <Link href="/payments">Send money →</Link>
        </Button>
      </div>
      <label className="mb-[14px] flex h-11 items-center gap-2.5 rounded-[11px] border border-[#e3e9e0] bg-white px-[13px] text-[#89978c]">
        <Search className="size-[18px]" aria-hidden="true" />
        <span className="sr-only">Search activity</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search transactions, people or merchants"
          className="min-w-0 flex-1 border-0 bg-transparent text-xs text-[#214b32] outline-none"
        />
      </label>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[10px] font-extrabold tracking-[.2em] text-[#5d6e63]">OCTOBER 2026</span>
        <span className="text-[11px] text-[#90a094]">Personal current account · fictional records</span>
      </div>
      <Card className="px-[19px]">
        <TransactionList transactions={filtered} loading={loading} />
      </Card>
    </section>
  );
}
