import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type PostgresError = Error & { code?: string };

export function isPostgresError(error: unknown, code: string): error is PostgresError {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The request did not match the expected format.",
          fields: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  // Keep database and configuration details on the server side. The public error is
  // intentionally stable so callers never receive credentials or SQL fragments.
  console.error("Glaramara API request failed", error);
  return NextResponse.json(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The fictional banking service is temporarily unavailable.",
      },
    },
    { status: 503 },
  );
}
