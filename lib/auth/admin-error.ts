import { NextResponse } from "next/server";

export const ADMIN_FORBIDDEN_MESSAGE = "Admin settings need a signed-in session or a token with the admin scope.";

/** Thrown by the instance-admin guards. The message stays "Unauthorized" or "Forbidden" for older catch blocks. */
export class AdminAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly publicMessage = status === 401 ? "Sign in to continue." : "You don't have access to this.",
  ) {
    super(status === 401 ? "Unauthorized" : "Forbidden");
    this.name = "AdminAuthError";
  }
}

/** The response for an admin guard failure, or null for any other error. */
export function adminAuthErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof AdminAuthError)) return null;
  return NextResponse.json({ error: error.publicMessage }, { status: error.status });
}

/** A guard failure in the `{ ok, message }` shape the verify routes return. */
export function adminVerifyRefusal(error: unknown): NextResponse {
  const refusal = error instanceof AdminAuthError ? error : new AdminAuthError(401);
  return NextResponse.json({ ok: false, message: refusal.publicMessage }, { status: refusal.status });
}
