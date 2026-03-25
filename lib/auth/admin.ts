import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

/**
 * Require the current user to be an app admin.
 * Works with both session cookies and Bearer API tokens
 * (getSession handles both transparently).
 *
 * Throws `Error("Unauthorized")` when no credential is present.
 * Throws `Error("Forbidden")` when credentials are valid but the caller is not an admin.
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
 * Require app-admin access. Accepts an optional request param for backwards
 * compatibility — Bearer token handling is now in getSession(), so the
 * request object is no longer needed.
 */
export async function requireAdminAuth(_request?: unknown): Promise<void> {
  await requireAppAdmin();
}
