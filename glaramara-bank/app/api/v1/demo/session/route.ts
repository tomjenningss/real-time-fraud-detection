import { type NextRequest, NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import {
  findDefaultDemoCustomer,
  listDemoCustomers,
  listDemoLocations,
  resolveDemoSession,
  sessionRequestSchema,
} from "@/lib/server/banking-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import {
  issueDemoSession,
  readDemoSession,
  setDemoSessionCookie,
} from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function sessionResponse(customerId: string, locationId?: string) {
  const [{ customer, location }, customers] = await Promise.all([
    resolveDemoSession(customerId, locationId),
    listDemoCustomers(),
  ]);
  const locations = await listDemoLocations(customer.id);
  const issued = issueDemoSession(customer.id, location.id);
  const response = NextResponse.json({
    session: {
      customerId: customer.id,
      demoLocationId: location.id,
      expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
    },
    customer,
    customers,
    locations,
  });
  setDemoSessionCookie(response, issued);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const existing = readDemoSession(request);
    if (existing) return await sessionResponse(existing.customerId, existing.demoLocationId);

    const { customer, location } = await findDefaultDemoCustomer();
    return await sessionResponse(customer.id, location.id);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await readJsonBody(request);
    const input = sessionRequestSchema.parse(body);
    return await sessionResponse(input.customerId, input.demoLocationId);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
