import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

const log = logger.child("api");

/**
 * Standard error response for API route catch blocks.
 * Returns 401 for auth errors, 500 for everything else.
 */
export function handleRouteError(error: unknown, context?: string) {
  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (context) {
    log.error(`${context}:`, error);
  }
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

// ---------------------------------------------------------------------------
// Postgres error helpers
// ---------------------------------------------------------------------------

/**
 * Extract the PostgreSQL error code from an unknown thrown value.
 * Checks both the error itself and `error.cause` for the `code` property.
 */
export function getPgErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const directCode =
    "code" in error ? (error as { code: string }).code : null;
  if (directCode) return directCode;
  if (
    error.cause &&
    typeof error.cause === "object" &&
    "code" in error.cause
  ) {
    return (error.cause as { code: string }).code;
  }
  return null;
}

/**
 * Check if an error is a Postgres unique violation (23505).
 */
export function isUniqueViolation(error: unknown): boolean {
  return getPgErrorCode(error) === "23505";
}
