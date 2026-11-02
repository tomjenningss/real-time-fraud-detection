import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-errors";
import {
  getFraudInvestigation,
  startFraudInvestigation,
} from "@/lib/server/fraud-investigation-repository";
import { requireSameOrigin } from "@/lib/server/origin";
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
    const investigation = await getFraudInvestigation(session.customerId, paymentIdSchema.parse(paymentId));
    return NextResponse.json({ investigation }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  try {
    requireSameOrigin(request);
    const session = requireDemoSession(request);
    const { paymentId } = await context.params;
    const investigation = await startFraudInvestigation(
      session.customerId,
      paymentIdSchema.parse(paymentId),
    );
    return NextResponse.json({ investigation }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
