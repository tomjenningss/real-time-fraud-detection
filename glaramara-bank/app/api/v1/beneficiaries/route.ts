import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import {
  beneficiaryRequestSchema,
  createBeneficiary,
  listBeneficiaries,
} from "@/lib/server/banking-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import { requireDemoSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = requireDemoSession(request);
    const beneficiaries = await listBeneficiaries(session.customerId);
    return NextResponse.json(
      { beneficiaries },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const session = requireDemoSession(request);
    const body = await readJsonBody(request);
    const input = beneficiaryRequestSchema.parse(body);
    const beneficiary = await createBeneficiary(session.customerId, input);
    return NextResponse.json(
      { beneficiary },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
