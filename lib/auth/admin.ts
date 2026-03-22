import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { user, apiTokens } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

/**
 * Require the current user to be an app admin (session-only).
 * Throws if not authenticated or not admin.
 */
export async function requireAppAdmin() {
  const session = await requireSession();
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  if (!dbUser?.isAppAdmin) {
    throw new Error("Forbidden");
  }
  return session;
}

/**
 * Require app-admin access via either a session cookie or a Bearer API token.
 *
 * Resolution order:
 *  1. `Authorization: Bearer <token>` header — token must belong to an app admin user
 *  2. Session cookie — user must be an app admin
 *
 * Throws `Error("Unauthorized")` when no credential is present.
 * Throws `Error("Forbidden")` when credentials are valid but the caller is not an admin.
 *
 * Use this in system-level routes that need to be accessible from the CLI.
 */
export async function requireAdminAuth(request: NextRequest): Promise<void> {
  const authHeader = request.headers.get("authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) {
      throw new Error("Unauthorized");
    }

    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const token = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.tokenHash, tokenHash),
      columns: { userId: true, id: true },
    });

    if (!token) {
      throw new Error("Unauthorized");
    }

    const tokenOwner = await db.query.user.findFirst({
      where: eq(user.id, token.userId),
      columns: { isAppAdmin: true },
    });

    if (!tokenOwner?.isAppAdmin) {
      throw new Error("Forbidden");
    }

    // Update lastUsedAt in the background — don't block the response
    db.update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .catch(() => {});

    return;
  }

  // Fall back to session auth
  await requireAppAdmin();
}
