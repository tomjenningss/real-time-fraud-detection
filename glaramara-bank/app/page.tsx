"use client";

import { ArrowRight, Clock3, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { useCustomer } from "@/components/customer-provider";
import { DataStateNotice } from "@/components/data-state-notice";
import { AccountMountain } from "@/components/mountain-mark";
import { TransactionList } from "@/components/transaction-list";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DashboardResponse } from "@/lib/banking-api";
import { useBankingResource } from "@/lib/use-banking-resource";
import { formatMoney } from "@/lib/utils";

const quickActions = [
  { href: "/payments", label: "Send money", icon: ArrowRight },
  { href: "/beneficiaries", label: "Add recipient", icon: Plus },
  { href: "/activity", label: "Activity", icon: Clock3 },
];

export default function OverviewPage() {
  const { customer, sessionReady } = useCustomer();
  const { data, error, loading } = useBankingResource<DashboardResponse>(
    "/api/v1/dashboard",
    customer.id,
    sessionReady,
  );
  const account = data?.account;
  const spending = data?.spending ?? [];

  return (
    <div>
      <DataStateNotice loading={loading} error={error} />
      <div className="grid grid-cols-1 gap-[23px] xl:grid-cols-[minmax(0,1.6fr)_minmax(270px,.85fr)]">
      <div className="flex min-w-0 flex-col gap-[23px]">
        <section className="relative min-h-[233px] overflow-hidden rounded-[20px] bg-[linear-gradient(130deg,#13392e_0%,#205543_65%,#295e4a_100%)] px-6 py-6 text-white shadow-[0_16px_30px_rgba(23,63,51,.14)] before:absolute before:-bottom-[105px] before:-right-[45px] before:h-[200px] before:w-[320px] before:-rotate-[18deg] before:rounded-[50%] before:border before:border-[#e5f7d329] after:absolute after:-bottom-[145px] after:-right-[60px] after:h-[230px] after:w-[410px] after:-rotate-[18deg] after:rounded-[50%] after:border after:border-[#e5f7d321] md:min-h-[252px] md:px-8 md:py-7">
          <div className="relative z-10 flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold text-[#d5ebdc]">Glaramara Current Account</p>
              <p className="mt-1 text-[11px] text-[#c1deca]">
                {customer.name} · •••• {account?.accountSuffix ?? "••••"}
              </p>
            </div>
            <AccountMountain className="-mr-2 -mt-[18px] h-[90px] w-[109px]" />
          </div>
          <p className="mt-2 text-[11px] text-[#bfdac8] md:mt-[27px]">Available balance</p>
          <p className="mt-1 text-[39px] font-extrabold tracking-[-2px] md:text-[43px]">
            {account ? formatMoney(account.availableBalance) : "£—"}
          </p>
          <div className="relative z-10 mt-5 flex items-center justify-between">
            <span className="text-[11px] text-[#deefe0]">Sort code {account?.sortCode ?? "—"}</span>
            <Button variant="outline" size="sm" type="button" title="All details are fictional">
              Account details ↗
            </Button>
          </div>
        </section>

        <section aria-label="Quick actions" className="grid grid-cols-3 gap-2.5 md:gap-3">
          {quickActions.map(({ href, label, icon: Icon }) => (
            <Link
              href={href}
              key={label}
              className="flex flex-col items-center gap-2 rounded-[15px] border border-[#e7ebe5] bg-white px-2 py-[15px] text-center text-xs font-bold shadow-soft transition hover:-translate-y-px hover:border-[#b7d6ad] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6b9d73] md:py-[18px]"
            >
              <span className="grid size-10 place-items-center rounded-[13px] bg-[#e9f3e7] text-[#2e644c]">
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
              {label}
            </Link>
          ))}
        </section>

        <section>
          <div className="mb-[13px] flex items-center justify-between gap-3">
            <h2 className="text-base font-bold tracking-[-.4px]">Recent activity</h2>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/activity">View all →</Link>
            </Button>
          </div>
          <Card className="px-[18px]">
            <TransactionList transactions={data?.recentTransactions ?? []} limit={4} loading={loading} />
          </Card>
        </section>
      </div>

      <aside className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:flex xl:flex-col xl:gap-[23px]">
        <Card className="p-[22px]">
          <h2 className="text-sm font-bold tracking-[-.2px]">October spending</h2>
          <div className="my-4 flex h-2 overflow-hidden rounded-full bg-[#edf2e9]">
            <span className="w-[49%] bg-[#2c7653]" />
            <span className="w-[22%] bg-[#84ae83]" />
            <span className="w-[14%] bg-[#c4dbac]" />
          </div>
          <div className="flex flex-col gap-[13px] text-[11px] text-[#56675d]">
            {spending.length ? (
              spending.slice(0, 3).map((item, index) => (
                <SpendLine
                  key={item.category}
                  colour={["#2c7653", "#84ae83", "#c4dbac"][index]}
                  label={item.label}
                  value={formatMoney(item.amount)}
                />
              ))
            ) : (
              <p>{loading ? "Calculating from booked records…" : "No debit spending recorded."}</p>
            )}
          </div>
        </Card>

        <Card className="border-[#d9e8d4] bg-[#e8f1e5] p-[22px]">
          <div className="grid size-[34px] place-items-center rounded-[11px] bg-[#d3e6cb] text-[#2f704c]">
            <ShieldCheck className="size-[18px]" aria-hidden="true" />
          </div>
          <h2 className="mt-[13px] text-sm font-bold">Protected by Glaramara</h2>
          <p className="mt-2 text-xs leading-relaxed text-[#47634f]">
            Every payment is checked before it is approved.
          </p>
        </Card>

        <Card className="border-[#dfeaca] bg-[#f0f4e8] p-[22px] sm:col-span-2 xl:col-span-1">
          <p className="text-[10px] font-extrabold tracking-[.15em] text-[#49644f]">MAKE A PAYMENT</p>
          <p className="my-2 text-[11px] leading-relaxed text-[#52675a]">
            Choose a recipient, check the details and follow the security guidance before you continue.
          </p>
          <Button asChild className="w-full">
            <Link href="/payments">Explore the payment journey →</Link>
          </Button>
        </Card>
      </aside>
      </div>
    </div>
  );
}

function SpendLine({ colour, label, value }: { colour: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-[7px]">
      <span className="size-2 rounded-full" style={{ backgroundColor: colour }} />
      {label}
      <strong className="ml-auto text-[#263c2d]">{value}</strong>
    </div>
  );
}
