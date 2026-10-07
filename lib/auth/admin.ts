import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession, requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";

/** Instance-admin power needs a signed-in session; API tokens never carry it. */
export function credentialMayAdmin(session: { authMethod: "token" | "session" }): boolean {
  return session.authMethod === "session";
}

/** Non-throwing admin check. */
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

/** Instance admin only: container discovery reads every host container's env. */
export async function canImportContainers(): Promise<boolean> {
  return (await isFeatureEnabledAsync("container-import")) && (await isAppAdmin());
}

/** Requires an app admin signed in with a session. Throws "Unauthorized" or "Forbidden". */
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

/** Requires app-admin access. The request param is unused. */
export async function requireAdminAuth(_request?: unknown): Promise<void> {
  await requireAppAdmin();
}
