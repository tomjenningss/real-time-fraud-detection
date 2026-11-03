"use client";

import { useSearchParams } from "next/navigation";

import { FraudIntelligencePanel } from "@/components/fraud-intelligence/fraud-intelligence-panel";
import { useSystemView } from "@/components/fraud-intelligence/system-view-provider";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function SystemViewJourney({ children }: { children: React.ReactNode }) {
  const paymentId = useSearchParams().get("paymentId") ?? "";
  const { enabled } = useSystemView();
  if (!enabled || !UUID_PATTERN.test(paymentId)) return children;

  return (
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(360px,.82fr)_minmax(510px,1.18fr)]">
      <div className="min-w-0">{children}</div>
      <FraudIntelligencePanel paymentId={paymentId} />
    </div>
  );
}
