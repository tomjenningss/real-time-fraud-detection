import { type NextRequest, NextResponse } from "next/server";

import { ApiError, apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import {
  datasetGenerationRequestSchema,
  listFraudLabDatasets,
  requestFraudLabDataset,
} from "@/lib/server/fraud-operations-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireAnalystSession(request);
    return NextResponse.json({ datasets: await listFraudLabDatasets() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const analyst = requireAnalystSession(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[\x20-\x7e]+$/.test(idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Supply a valid Idempotency-Key header.");
    }
    const input = datasetGenerationRequestSchema.parse(await readJsonBody(request));
    const dataset = await requestFraudLabDataset(analyst.analystId, idempotencyKey, input);
    return NextResponse.json({ dataset }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
