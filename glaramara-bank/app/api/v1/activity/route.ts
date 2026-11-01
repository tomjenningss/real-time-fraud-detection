import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-errors";
import { getActivity } from "@/lib/server/banking-repository";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = requireDemoSession(request);
    const transactions = await getActivity(session.customerId);
    return NextResponse.json(
      { transactions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
