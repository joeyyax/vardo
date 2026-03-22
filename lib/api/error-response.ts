import { NextResponse } from "next/server";

/**
 * Standard error response for API route catch blocks.
 * Returns 401 for auth errors, 500 for everything else.
 */
export function handleRouteError(error: unknown, context?: string) {
  if (error instanceof Error && error.message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (context) {
    console.error(`${context}:`, error);
  }
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}
