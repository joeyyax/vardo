import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";

/**
 * Require the current user to be an app admin.
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
