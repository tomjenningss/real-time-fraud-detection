import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { FraudOperationsClient } from "@/app/fraud-operations/fraud-operations-client";
import { DEMO_SESSION_COOKIE, verifyDemoSession } from "@/lib/server/session";

export default async function FraudOperationsPage() {
  const token = (await cookies()).get(DEMO_SESSION_COOKIE)?.value;
  const claims = token ? verifyDemoSession(token) : null;
  if (!claims || !("role" in claims) || claims.role !== "FRAUD_ANALYST") redirect("/");
  return <FraudOperationsClient />;
}

