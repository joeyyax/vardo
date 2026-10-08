// Deploy-time gate for #891: drops domains the org hasn't proved it owns.

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { loadInstanceHosts, loadVerifiedZones } from "./context";
import { isRoutable } from "./ownership";

type Candidate = { domain: string; verifiedAt?: Date | null };

/** Splits rows into those that may route and those that may not. System-managed orgs route the console itself. */
export async function splitRoutable<T extends Candidate>(
  rows: T[],
  org: { id: string; trusted: boolean; isSystemManaged?: boolean },
): Promise<{ routable: T[]; dropped: T[] }> {
  if (org.isSystemManaged || rows.length === 0) return { routable: rows, dropped: [] };

  const inst = await loadInstanceHosts();
  const zones = await loadVerifiedZones(org.id);
  // An environment's own hostname carries no proof; a verified domain row for the same host supplies it.
  const proven = new Set(
    (await db
      .select({ domain: domains.domain })
      .from(domains)
      .innerJoin(apps, eq(domains.appId, apps.id))
      .where(and(eq(apps.organizationId, org.id), isNotNull(domains.verifiedAt)))
    ).map((r) => r.domain.toLowerCase()),
  );

  const routable: T[] = [];
  const dropped: T[] = [];
  for (const row of rows) {
    const verifiedAt = row.verifiedAt ?? (proven.has(row.domain.toLowerCase()) ? new Date(0) : null);
    (isRoutable({ domain: row.domain, verifiedAt }, inst, org, zones) ? routable : dropped).push(row);
  }
  return { routable, dropped };
}
