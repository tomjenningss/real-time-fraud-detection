import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/server/api-errors";
import {
  findDefaultDemoCustomer,
  listDemoCustomers,
  listDemoLocations,
  resolveDemoSession,
} from "@/lib/server/banking-repository";
import { requireSameOrigin } from "@/lib/server/origin";
import {
  issueDemoSession,
  issueAnalystSession,
  readSignedSession,
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
    customers: [...customers, ANALYST_PERSONA],
    locations,
  });
  setDemoSessionCookie(response, issued);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

const ANALYST_PERSONA = {
  id: "fraud-analyst-alex-morgan", slug: "fraud-analyst-alex-morgan", name: "Alex Morgan — Fraud Analyst",
  firstName: "Alex", lastName: "Morgan", initials: "AM", role: "FRAUD_ANALYST" as const,
};
const personaRequestSchema = z.object({ customerId: z.string().min(1), demoLocationId: z.string().uuid().optional() });

async function analystResponse() {
  const customers = await listDemoCustomers();
  const issued = issueAnalystSession();
  const response = NextResponse.json({
    session: { customerId: ANALYST_PERSONA.id, demoLocationId: null, role: "FRAUD_ANALYST", expiresAt: new Date(issued.claims.exp * 1000).toISOString() },
    customer: ANALYST_PERSONA,
    customers: [...customers, ANALYST_PERSONA],
    locations: [],
  });
  setDemoSessionCookie(response, issued);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const existing = readSignedSession(request);
    if (existing && "role" in existing && existing.role === "FRAUD_ANALYST") return await analystResponse();
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
    const input = personaRequestSchema.parse(body);
    if (input.customerId === ANALYST_PERSONA.id) return await analystResponse();
    z.string().uuid().parse(input.customerId);
    return await sessionResponse(input.customerId, input.demoLocationId);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
