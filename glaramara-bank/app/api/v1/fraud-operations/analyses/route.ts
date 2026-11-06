import { type NextRequest, NextResponse } from "next/server";

import { FraudRuleDiscoveryDiagnosticError } from "@/lib/fraud-rule-discovery/orchestrate-client";
import { ApiError, apiErrorResponse } from "@/lib/server/api-errors";
import { startDiscoveryAnalysis } from "@/lib/server/fraud-operations-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const analyst = requireAnalystSession(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[\x20-\x7e]+$/.test(idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Supply a valid Idempotency-Key header.");
    }
    const run = await startDiscoveryAnalysis(analyst.analystId, idempotencyKey);
    return NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof FraudRuleDiscoveryDiagnosticError && error.diagnostic.validationStage !== "INVOCATION") {
      return apiErrorResponse(new ApiError(
        422,
        "FRAUD_LAB_INVALID_PROPOSAL",
        "The fraud analysis returned an invalid proposal and was stopped safely. The fictional banking service remains available.",
      ));
    }
    return apiErrorResponse(error);
  }
}

