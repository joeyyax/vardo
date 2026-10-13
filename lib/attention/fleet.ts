import "server-only";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, domainChecks, domains, systemSettings } from "@/lib/db/schema";
import { DOMAIN_FAILURES_TO_CONFIRM, isConfirmedUnreachable } from "./domain-health";
import {
  ALERT_STATE_KEY,
  selectActiveServiceAlerts,
  type PersistedAlertEntry,
  type ServiceDown,
} from "./service-alerts";

export type FleetAttention = {
  unreachableDomains: { id: string; domain: string; appName: string | null; error: string | null }[];
};

/** Domains whose most recent check failed. */
export async function getFleetAttention(orgId: string): Promise<FleetAttention> {
  return { unreachableDomains: await loadUnreachableDomains(orgId) };
}

async function loadUnreachableDomains(orgId: string): Promise<FleetAttention["unreachableDomains"]> {
  // Only running apps, so a retired app's last failed check doesn't linger.
  const orgDomains = await db
    .select({ id: domains.id, domain: domains.domain, appName: apps.name })
    .from(domains)
    .leftJoin(apps, eq(apps.id, domains.appId))
    .where(and(eq(apps.organizationId, orgId), eq(apps.status, "active")));

  if (orgDomains.length === 0) return [];

  // Latest checks per domain, capped in SQL.
  const ids = orgDomains.map((d) => d.id);
  const ranked = db
    .select({
      domainId: domainChecks.domainId,
      reachable: domainChecks.reachable,
      error: domainChecks.error,
      checkedAt: domainChecks.checkedAt,
      rn: sql<number>`row_number() over (partition by ${domainChecks.domainId} order by ${domainChecks.checkedAt} desc)`.as("rn"),
    })
    .from(domainChecks)
    .where(inArray(domainChecks.domainId, ids))
    .as("ranked");
  const checks = await db
    .select({
      domainId: ranked.domainId,
      reachable: ranked.reachable,
      error: ranked.error,
      checkedAt: ranked.checkedAt,
    })
    .from(ranked)
    .where(lte(ranked.rn, DOMAIN_FAILURES_TO_CONFIRM))
    .orderBy(desc(ranked.checkedAt));

  // Two most recent per domain, so a single aborted request doesn't read as unreachable.
  const recent = new Map<string, (typeof checks)[number][]>();
  for (const check of checks) {
    const seen = recent.get(check.domainId) ?? [];
    if (seen.length < DOMAIN_FAILURES_TO_CONFIRM) {
      seen.push(check);
      recent.set(check.domainId, seen);
    }
  }

  return orgDomains
    .filter((d) => isConfirmedUnreachable(recent.get(d.id) ?? []))
    .map((d) => ({
      id: d.id,
      domain: d.domain,
      appName: d.appName,
      error: recent.get(d.id)?.[0]?.error ?? null,
    }));
}

/** Services the health monitor is still alerting on. Instance-wide. */
export async function getServicesDown(now = new Date()): Promise<ServiceDown[]> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, ALERT_STATE_KEY),
  });
  if (!row?.value) return [];

  let parsed: Record<string, PersistedAlertEntry>;
  try {
    parsed = typeof row.value === "string" ? JSON.parse(row.value) : (row.value as never);
  } catch {
    return [];
  }

  return selectActiveServiceAlerts(parsed, now);
}
