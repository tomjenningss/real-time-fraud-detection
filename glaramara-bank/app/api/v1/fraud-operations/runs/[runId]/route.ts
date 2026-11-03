import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getDiscoveryRun } from "@/lib/server/fraud-operations-repository";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    requireAnalystSession(request);
    const { runId } = await context.params;
    return NextResponse.json({ run: await getDiscoveryRun(z.string().uuid().parse(runId)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

