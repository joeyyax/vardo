// Lookup for the Vardo system org that holds the core service apps.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { VARDO_ORG_SLUG } from "@/lib/infra/vardo-org";

/** ID of the Vardo system org, or null before it exists. */
export async function getCoreOrgId(): Promise<string | null> {
  const org = await db.query.organizations.findFirst({
    where: and(eq(organizations.slug, VARDO_ORG_SLUG), eq(organizations.isSystemManaged, true)),
    columns: { id: true },
  });
  return org?.id ?? null;
}
