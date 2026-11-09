import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse, ApiError } from "@/lib/server/api-errors";
import { requireSameOrigin } from "@/lib/server/origin";
import {
  createSlowBuildingDemoRun,
  getSlowBuildingDemoRun,
} from "@/lib/server/slow-building-demo-repository";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireAnalystSession(request);
    const runId = request.nextUrl.searchParams.get("runId");
    if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new ApiError(400, "INVALID_SLOW_BUILDING_RUN_ID", "A valid replay run ID is required.");
    }
    return NextResponse.json(await getSlowBuildingDemoRun(runId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    requireAnalystSession(request);
    return NextResponse.json(await createSlowBuildingDemoRun(), {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
