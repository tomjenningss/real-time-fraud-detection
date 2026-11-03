import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import { reviewCandidate, reviewRequestSchema } from "@/lib/server/fraud-operations-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireAnalystSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ candidateId: string }> }) {
  try {
    requireSameOrigin(request);
    const analyst = requireAnalystSession(request);
    const { candidateId } = await context.params;
    const input = reviewRequestSchema.parse(await readJsonBody(request));
    const run = await reviewCandidate(
      z.string().uuid().parse(candidateId), analyst.analystId, analyst.reviewerName, input,
    );
    return NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
