import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import {
  activateFraudLabDataset,
  datasetActivationRequestSchema,
} from "@/lib/server/fraud-operations-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ datasetId: string }> },
) {
  try {
    requireSameOrigin(request);
    const analyst = requireAnalystSession(request);
    datasetActivationRequestSchema.parse(await readJsonBody(request));
    const { datasetId } = await context.params;
    const dataset = await activateFraudLabDataset(z.string().uuid().parse(datasetId), analyst.analystId);
    return NextResponse.json({ dataset }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
