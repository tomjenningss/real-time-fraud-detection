import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getFraudIntelligenceView } from "@/lib/server/fraud-intelligence-repository";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentIdSchema = z.string().uuid();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  try {
    const session = requireDemoSession(request);
    const { paymentId } = await context.params;
    const investigation = await getFraudIntelligenceView(
      session.customerId,
      paymentIdSchema.parse(paymentId),
    );
    return NextResponse.json(
      { investigation },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
