import { Suspense } from "react";

import { Card } from "@/components/ui/card";
import { SystemViewJourney } from "@/components/fraud-intelligence/system-view-journey";

import { FraudInvestigationClient } from "./fraud-investigation-client";

export default function FraudInvestigationPage() {
  return (
    <Suspense fallback={<Card className="max-w-[680px] p-6 text-xs text-[#7b8a80] md:p-8">Loading the security check…</Card>}>
      <SystemViewJourney>
        <FraudInvestigationClient />
      </SystemViewJourney>
    </Suspense>
  );
}
