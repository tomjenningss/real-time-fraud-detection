import { Suspense } from "react";

import { Card } from "@/components/ui/card";

import { PaymentStatusClient } from "./payment-status-client";

export default function PaymentStatusPage() {
  return (
    <Suspense
      fallback={
        <Card className="max-w-[680px] p-6 text-xs text-[#7b8a80] md:p-8">
          Loading the fictional payment status…
        </Card>
      }
    >
      <PaymentStatusClient />
    </Suspense>
  );
}
