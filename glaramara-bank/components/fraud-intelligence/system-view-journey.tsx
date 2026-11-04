"use client";

import { ChevronDown, Workflow } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { FraudDecisionBreakdown } from "@/components/fraud-intelligence/fraud-decision-breakdown";
import { FraudIntelligencePanel } from "@/components/fraud-intelligence/fraud-intelligence-panel";
import { useSystemView } from "@/components/fraud-intelligence/system-view-provider";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SystemViewJourney({ children }: { children: React.ReactNode }) {
  const paymentId = useSearchParams().get("paymentId") ?? "";
  const { enabled } = useSystemView();
  if (!enabled || !UUID_PATTERN.test(paymentId)) return children;

  return (
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(360px,1.12fr)_minmax(510px,.88fr)]">
      <div className="min-w-0">
        {children}
        <FraudDecisionBreakdown paymentId={paymentId} />
      </div>
      <details open className="group min-w-0 overflow-hidden rounded-[18px] border border-[#d9e5d7] bg-[#f9fcf7] shadow-[0_10px_30px_#173f3308]">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 marker:content-none">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#e7f1df] text-[#275A47]">
            <Workflow className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm font-extrabold tracking-[-.2px] text-[#173f33]">Architecture flow</strong>
            <span className="mt-0.5 block text-[10px] leading-relaxed text-[#68796e]">Live persisted evidence path · read only</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-[#55705e] transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-[#dfe8dc] p-3">
          <FraudIntelligencePanel paymentId={paymentId} />
        </div>
      </details>
    </div>
  );
}
