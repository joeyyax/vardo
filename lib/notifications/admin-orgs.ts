import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, user } from "@/lib/db/schema";

/** Orgs with an instance admin as a member; every org when none has one. */
export async function adminOrgIds(): Promise<string[]> {
  const rows = await db
    .select({ id: memberships.organizationId })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(user.isAppAdmin, true));
  const ids = [...new Set(rows.map((r) => r.id))];
  if (ids.length > 0) return ids;
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  return orgs.map((o) => o.id);
}
