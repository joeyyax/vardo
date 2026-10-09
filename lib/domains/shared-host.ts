// A host may carry several path routes, all from one organization.

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";

/** Whether another organization routes any path on this host. */
export async function hostHeldByOtherOrg(host: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: domains.id })
    .from(domains)
    .innerJoin(apps, eq(domains.appId, apps.id))
    .where(and(eq(domains.domain, host.toLowerCase()), ne(apps.organizationId, orgId)))
    .limit(1);
  return !!row;
}
