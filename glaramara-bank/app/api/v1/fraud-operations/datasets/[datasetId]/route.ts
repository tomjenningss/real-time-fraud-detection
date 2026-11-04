import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getFraudLabDataset } from "@/lib/server/fraud-operations-repository";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ datasetId: string }> }) {
  try {
    requireAnalystSession(request);
    const { datasetId } = await context.params;
    return NextResponse.json(
      { dataset: await getFraudLabDataset(z.string().uuid().parse(datasetId)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
