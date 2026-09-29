import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession, requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

/** Instance-admin power needs a signed-in session; API tokens never carry it. */
export function credentialMayAdmin(session: { authMethod: "token" | "session" }): boolean {
  return session.authMethod === "session";
}

/** Non-throwing admin check, for deciding whether to show admin-only affordances. */
export async function isAppAdmin(): Promise<boolean> {
  const session = await getSession();
  if (!session?.user?.id) return false;
  if (!credentialMayAdmin(session)) return false;
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  return Boolean(dbUser?.isAppAdmin);
}

/**
 * Require the current user to be an app admin, signed in with a session.
 *
 * Throws `Error("Unauthorized")` when no credential is present.
 * Throws `Error("Forbidden")` when credentials are valid but the caller is not an admin.
 */
export async function requireAppAdmin() {
  const session = await requireSession();
  if (!credentialMayAdmin(session)) throw new Error("Forbidden");
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
 * Require app-admin access. The request param is unused and kept for callers.
 */
export async function requireAdminAuth(_request?: unknown): Promise<void> {
  await requireAppAdmin();
}
