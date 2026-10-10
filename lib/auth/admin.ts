import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { AdminAuthError, ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";

export { AdminAuthError, ADMIN_FORBIDDEN_MESSAGE, adminAuthErrorResponse } from "@/lib/auth/admin-error";

/** Instance-admin power needs a signed-in session or a token with the admin scope. */
export function credentialMayAdmin(session: {
  authMethod: "token" | "session";
  tokenScope?: { admin?: boolean };
}): boolean {
  if (session.authMethod === "session") return true;
  return session.tokenScope?.admin === true;
}

async function userIsAppAdmin(userId: string): Promise<boolean> {
  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { isAppAdmin: true },
  });
  return Boolean(dbUser?.isAppAdmin);
}

/** Non-throwing admin check. */
export async function isAppAdmin(): Promise<boolean> {
  const session = await getSession();
  if (!session?.user?.id) return false;
  if (!credentialMayAdmin(session)) return false;
  return userIsAppAdmin(session.user.id);
}

/** Instance admin only: container discovery reads every host container's env. */
export async function canImportContainers(): Promise<boolean> {
  return (await isFeatureEnabledAsync("container-import")) && (await isAppAdmin());
}

/** Requires an app admin with a session or an admin-scoped token. Throws AdminAuthError. */
export async function requireAppAdmin() {
  const session = await getSession();
  if (!session?.user?.id) throw new AdminAuthError(401);
  if (!credentialMayAdmin(session)) throw new AdminAuthError(403, ADMIN_FORBIDDEN_MESSAGE);
  if (!(await userIsAppAdmin(session.user.id))) throw new AdminAuthError(403);
  return session;
}

/** Requires app-admin access. The request param is unused. */
export async function requireAdminAuth(_request?: unknown): Promise<void> {
  await requireAppAdmin();
}
