import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse, ApiError, readJsonBody } from "@/lib/server/api-errors";
import {
  createPaymentAttempt,
  paymentRequestSchema,
} from "@/lib/server/banking-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readIdempotencyKey(request: NextRequest): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw new ApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required for payment submission.",
    );
  }
  if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "The Idempotency-Key must contain 1 to 128 visible ASCII characters.",
    );
  }
  return key;
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const session = requireDemoSession(request);
    const idempotencyKey = readIdempotencyKey(request);
    const input = paymentRequestSchema.parse(await readJsonBody(request));
    const result = await createPaymentAttempt(
      session.customerId,
      session.demoLocationId,
      idempotencyKey,
      input,
    );
    return NextResponse.json(result, {
      status: result.replayed ? 200 : 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
