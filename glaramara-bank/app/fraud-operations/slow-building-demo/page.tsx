import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SlowBuildingDemoClient } from "@/app/fraud-operations/slow-building-demo/slow-building-demo-client";
import { DEMO_SESSION_COOKIE, verifyDemoSession } from "@/lib/server/session";

export default async function SlowBuildingDemoPage() {
  const token = (await cookies()).get(DEMO_SESSION_COOKIE)?.value;
  const claims = token ? verifyDemoSession(token) : null;
  if (!claims || !("role" in claims) || claims.role !== "FRAUD_ANALYST") redirect("/");
  return <SlowBuildingDemoClient />;
}
