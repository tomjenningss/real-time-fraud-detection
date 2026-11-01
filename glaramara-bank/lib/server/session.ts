import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/server/api-errors";

export const DEMO_SESSION_COOKIE = "glaramara_demo_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

const claimsSchema = z.object({
  v: z.literal(1),
  customerId: z.string().uuid(),
  demoLocationId: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export type DemoSessionClaims = z.infer<typeof claimsSchema>;

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

export type IssuedDemoSession = { claims: DemoSessionClaims; token: string };

export function issueDemoSession(
  customerId: string,
  demoLocationId: string,
  now = new Date(),
): IssuedDemoSession {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: DemoSessionClaims = {
    v: 1,
    customerId,
    demoLocationId,
    iat,
    exp: iat + SESSION_DURATION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(encodedPayload).toString("base64url");
  return { claims, token: `${encodedPayload}.${signature}` };
}

export function verifyDemoSession(token: string, now = new Date()): DemoSessionClaims | null {
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
  return token ? verifyDemoSession(token) : null;
}

export function requireDemoSession(request: NextRequest): DemoSessionClaims {
  const claims = readDemoSession(request);
  if (!claims) {
    throw new ApiError(401, "DEMO_SESSION_REQUIRED", "Start a fictional customer session first.");
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
