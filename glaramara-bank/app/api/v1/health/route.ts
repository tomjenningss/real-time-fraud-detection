import { NextResponse } from "next/server";

import { query } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await query("SELECT 1");
    return NextResponse.json(
      { status: "ready", service: "glaramara-bank" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Glaramara readiness check failed", error);
    return NextResponse.json(
      { status: "unavailable", service: "glaramara-bank" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
