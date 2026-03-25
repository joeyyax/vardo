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
