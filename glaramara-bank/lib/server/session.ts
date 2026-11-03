import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/server/api-errors";

export const DEMO_SESSION_COOKIE = "glaramara_demo_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

const legacyClaimsSchema = z.object({
  v: z.literal(1),
  customerId: z.string().uuid(),
  demoLocationId: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

const customerClaimsSchema = z.object({
  v: z.literal(2), role: z.literal("CUSTOMER"), customerId: z.string().uuid(),
  demoLocationId: z.string().uuid(), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
});
const analystClaimsSchema = z.object({
  v: z.literal(2), role: z.literal("FRAUD_ANALYST"),
  analystId: z.literal("fraud-analyst-alex-morgan"), reviewerName: z.literal("Alex Morgan"),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
});
const claimsSchema = z.union([legacyClaimsSchema, customerClaimsSchema, analystClaimsSchema]);

export type SignedSessionClaims = z.infer<typeof claimsSchema>;
export type DemoSessionClaims = { role: "CUSTOMER"; customerId: string; demoLocationId: string; iat: number; exp: number };
export type AnalystSessionClaims = z.infer<typeof analystClaimsSchema>;

function getSessionSecret(): string {
  const secret = process.env.GLARAMARA_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("GLARAMARA_SESSION_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function secureSessionCookie(): boolean {
  const configured = process.env.GLARAMARA_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV === "production";
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", getSessionSecret()).update(encodedPayload).digest();
}

export type IssuedDemoSession = { claims: SignedSessionClaims; token: string };

function issueClaims(claims: SignedSessionClaims): IssuedDemoSession {
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(encodedPayload).toString("base64url");
  return { claims, token: `${encodedPayload}.${signature}` };
}

export function issueDemoSession(
  customerId: string,
  demoLocationId: string,
  now = new Date(),
): IssuedDemoSession {
  const iat = Math.floor(now.getTime() / 1000);
  const claims = {
    v: 2 as const,
    role: "CUSTOMER" as const,
    customerId,
    demoLocationId,
    iat,
    exp: iat + SESSION_DURATION_SECONDS,
  };
  return issueClaims(claims);
}

export function issueAnalystSession(now = new Date()): IssuedDemoSession {
  const iat = Math.floor(now.getTime() / 1000);
  return issueClaims({
    v: 2, role: "FRAUD_ANALYST", analystId: "fraud-analyst-alex-morgan", reviewerName: "Alex Morgan",
    iat, exp: iat + SESSION_DURATION_SECONDS,
  });
}

export function verifyDemoSession(token: string, now = new Date()): SignedSessionClaims | null {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;

  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const rawClaims: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const claims = claimsSchema.parse(rawClaims);
    if (claims.exp <= Math.floor(now.getTime() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function readDemoSession(request: NextRequest): DemoSessionClaims | null {
  const token = request.cookies.get(DEMO_SESSION_COOKIE)?.value;
  const claims = token ? verifyDemoSession(token) : null;
  if (!claims || ("role" in claims && claims.role !== "CUSTOMER")) return null;
  return {
    role: "CUSTOMER", customerId: claims.customerId, demoLocationId: claims.demoLocationId,
    iat: claims.iat, exp: claims.exp,
  };
}

export function readSignedSession(request: NextRequest): SignedSessionClaims | null {
  const token = request.cookies.get(DEMO_SESSION_COOKIE)?.value;
  return token ? verifyDemoSession(token) : null;
}

export function requireDemoSession(request: NextRequest): DemoSessionClaims {
  const claims = readDemoSession(request);
  if (!claims) {
    throw new ApiError(401, "DEMO_SESSION_REQUIRED", "Start a fictional customer session first.");
  }
  return claims;
}

export function requireAnalystSession(request: NextRequest): AnalystSessionClaims {
  const claims = readSignedSession(request);
  if (!claims || !("role" in claims) || claims.role !== "FRAUD_ANALYST") {
    throw new ApiError(403, "FRAUD_ANALYST_SESSION_REQUIRED", "Switch to the fictional fraud analyst persona first.");
  }
  return claims;
}

export function setDemoSessionCookie(
  response: NextResponse,
  issued: IssuedDemoSession,
): void {
  response.cookies.set({
    name: DEMO_SESSION_COOKIE,
    value: issued.token,
    httpOnly: true,
    sameSite: "lax",
    secure: secureSessionCookie(),
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}
