import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getPaymentStatus } from "@/lib/server/banking-repository";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentIdSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/v1/payments/[paymentId]">,
) {
  try {
    const session = requireDemoSession(request);
    const { paymentId } = await context.params;
    const payment = await getPaymentStatus(session.customerId, paymentIdSchema.parse(paymentId));
    return NextResponse.json(
      { payment },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
