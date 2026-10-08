// Background re-check of domain ownership (#891).

import { and, eq, isNotNull } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/lib/db";
import { apps, domains, organizations, orgDomains } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { loadInstanceHosts, loadVerifiedZones } from "./context";
import { coveredByZone, isUnder } from "./ownership";
import { runCheck, type Target } from "./verify";

const log = logger.child("domain-verification");

/**
 * Checks every challenge-bound row. Pending rows verify once the record appears; verified rows lose
 * it when the record is gone. Trusted orgs and hosts under the instance base are skipped.
 */
export async function recheckDomainOwnership(): Promise<{ checked: number }> {
  const inst = await loadInstanceHosts();
  const outside = (host: string) => !inst.base || !isUnder(host, inst.base);

  const [appRows, zoneRows, baseRows] = await Promise.all([
    db
      .select({ id: domains.id, domain: domains.domain, orgId: apps.organizationId })
      .from(domains)
      .innerJoin(apps, eq(domains.appId, apps.id))
      .innerJoin(organizations, eq(apps.organizationId, organizations.id))
      .where(eq(organizations.trusted, false)),
    db
      .select({ id: orgDomains.id, domain: orgDomains.domain })
      .from(orgDomains)
      .innerJoin(organizations, eq(orgDomains.organizationId, organizations.id))
      .where(and(eq(organizations.trusted, false), eq(orgDomains.isDefault, false))),
    db
      .select({ id: organizations.id, domain: organizations.baseDomain })
      .from(organizations)
      .where(and(eq(organizations.trusted, false), isNotNull(organizations.baseDomain))),
  ]);

  // A domain inside a verified zone needs no record of its own.
  const zones = new Map<string, string[]>();
  for (const orgId of new Set(appRows.map((r) => r.orgId))) zones.set(orgId, await loadVerifiedZones(orgId));

  const targets: Target[] = [
    ...appRows.filter((r) => outside(r.domain) && !coveredByZone(r.domain, zones.get(r.orgId) ?? [])).map((r) => ({ kind: "app-domain" as const, id: r.id })),
    ...zoneRows.filter((r) => outside(r.domain)).map((r) => ({ kind: "org-domain" as const, id: r.id })),
    ...baseRows.filter((r) => r.domain && outside(r.domain)).map((r) => ({ kind: "org-base" as const, id: r.id })),
  ];

  const limit = pLimit(5);
  await Promise.all(
    targets.map((t) =>
      limit(async () => {
        try {
          await runCheck(t, { revoke: true });
        } catch (err) {
          log.error(`Check failed for ${t.kind} ${t.id}:`, err);
        }
      }),
    ),
  );
  return { checked: targets.length };
}
