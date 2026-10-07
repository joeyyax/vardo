import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

const log = logger.child("api");

/** Error response for API catch blocks: 401 for auth errors, else 500. */
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

/** PostgreSQL error code from a thrown value or its `cause`. */
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

/** Violated constraint name from a thrown value or its `cause`. */
export function getPgConstraint(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const direct =
    "constraint" in error ? (error as { constraint: unknown }).constraint : null;
  if (typeof direct === "string") return direct;
  if (
    error.cause &&
    typeof error.cause === "object" &&
    "constraint" in error.cause
  ) {
    const fromCause = (error.cause as { constraint: unknown }).constraint;
    if (typeof fromCause === "string") return fromCause;
  }
  return null;
}

/** Whether an error is a Postgres unique violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return getPgErrorCode(error) === "23505";
}
