"use client";

import { LockKeyhole } from "lucide-react";

import { useCustomer } from "@/components/customer-provider";
import { DataStateNotice } from "@/components/data-state-notice";
import { CardMountain } from "@/components/mountain-mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DashboardResponse } from "@/lib/banking-api";
import { useBankingResource } from "@/lib/use-banking-resource";

export default function CardsPage() {
  const { customer, sessionReady } = useCustomer();
  const { data, error, loading } = useBankingResource<DashboardResponse>(
    "/api/v1/dashboard",
    customer.id,
    sessionReady,
  );

  return (
    <section>
      <DataStateNotice loading={loading} error={error} />
      <div className="mb-[18px]">
        <h2 className="text-[17px] font-bold tracking-[-.4px]">Your cards</h2>
        <p className="mt-1 text-xs text-[#89968b]">Everyday banking with a little Lake District character.</p>
      </div>
      <Card className="max-w-[580px] p-5 md:p-[25px]">
        <div className="flex aspect-[1.65] max-w-[450px] flex-col justify-between rounded-[19px] bg-[linear-gradient(130deg,#164532,#327557)] p-6 text-white shadow-[0_19px_35px_#173e3229] md:p-[27px]">
          <div className="flex items-start justify-between">
            <strong className="text-[19px] tracking-[-.6px]">glaramara.</strong>
            <CardMountain className="h-[65px] w-20" />
          </div>
          <div className="text-[clamp(13px,3.2vw,19px)] tracking-[.2em]">•••• &nbsp; •••• &nbsp; •••• &nbsp; {data?.account.cardLastFour ?? "••••"}</div>
          <div className="flex justify-between text-xs">
            <span>{customer.name.toUpperCase()}</span>
            <strong>VISA</strong>
          </div>
        </div>
        <h3 className="mb-1 mt-6 text-[15px] font-bold">Your Glaramara debit card</h3>
        <p className="text-[11px] leading-relaxed text-[#839589]">
          A fictional card for demonstration. It is not connected to any card network and cannot be used.
        </p>
        <Button variant="secondary" type="button" disabled className="mt-4">
          <LockKeyhole className="size-4" /> Card controls unavailable in this demo
        </Button>
      </Card>
    </section>
  );
}
