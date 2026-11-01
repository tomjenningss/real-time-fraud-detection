import "server-only";

import type { NextRequest } from "next/server";

import { ApiError } from "@/lib/server/api-errors";

export function requireSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new ApiError(403, "ORIGIN_REQUIRED", "A same-origin browser request is required.");
  }

  let suppliedOrigin: string;
  try {
    suppliedOrigin = new URL(origin).origin;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "The request origin is not valid.");
  }

  const configuredOrigin = process.env.GLARAMARA_PUBLIC_ORIGIN?.trim();
  const host = request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(":", "");
  const expectedOrigin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : host && (protocol === "http" || protocol === "https")
      ? `${protocol}://${host}`
      : null;

  if (!expectedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new ApiError(403, "CROSS_ORIGIN_REQUEST", "Cross-origin mutations are not allowed.");
  }
}
