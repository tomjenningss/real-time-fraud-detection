import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getFraudOperationsDashboard } from "@/lib/server/fraud-operations-repository";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireAnalystSession(request);
    return NextResponse.json(await getFraudOperationsDashboard(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

