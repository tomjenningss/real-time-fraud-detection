import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, ApiError, readJsonBody } from "@/lib/server/api-errors";
import {
  answerFraudQuestion,
  executeFraudIntelligence,
  investigationAnswerRequestSchema,
} from "@/lib/server/fraud-investigation-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentIdSchema = z.string().uuid();

function idempotencyKey(request: NextRequest) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
  if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Use 1 to 128 visible ASCII characters.");
  }
  return key;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  try {
    requireSameOrigin(request);
    const session = requireDemoSession(request);
    const { paymentId } = await context.params;
    let investigation = await answerFraudQuestion(
      session.customerId,
      paymentIdSchema.parse(paymentId),
      idempotencyKey(request),
      investigationAnswerRequestSchema.parse(await readJsonBody(request)),
    );
    if (investigation?.status === "READY_FOR_EXTRACTION") {
      investigation = await executeFraudIntelligence(session.customerId, paymentId);
    }
    return NextResponse.json({ investigation }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
