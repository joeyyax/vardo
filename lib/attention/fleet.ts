import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, domainChecks, domains, systemSettings } from "@/lib/db/schema";
import {
  ALERT_STATE_KEY,
  selectActiveServiceAlerts,
  type PersistedAlertEntry,
  type ServiceDown,
} from "./service-alerts";

export type FleetAttention = {
  unreachableDomains: { id: string; domain: string; appName: string | null; error: string | null }[];
  servicesDown: ServiceDown[];
};

/** Domains whose most recent check failed, and services still alerting. */
export async function getFleetAttention(orgId: string, now = new Date()): Promise<FleetAttention> {
  const [unreachableDomains, servicesDown] = await Promise.all([
    loadUnreachableDomains(orgId),
    loadServicesDown(now),
  ]);
  return { unreachableDomains, servicesDown };
}

async function loadUnreachableDomains(orgId: string): Promise<FleetAttention["unreachableDomains"]> {
  const orgDomains = await db
    .select({ id: domains.id, domain: domains.domain, appName: apps.name })
    .from(domains)
    .leftJoin(apps, eq(apps.id, domains.appId))
    .where(eq(apps.organizationId, orgId));

  if (orgDomains.length === 0) return [];

  // Latest check per domain. One query, then reduce — a lateral join per domain
  // costs more than sorting a few hundred rows here.
  const ids = orgDomains.map((d) => d.id);
  const checks = await db
    .select({
      domainId: domainChecks.domainId,
      reachable: domainChecks.reachable,
      error: domainChecks.error,
      checkedAt: domainChecks.checkedAt,
    })
    .from(domainChecks)
    .where(inArray(domainChecks.domainId, ids))
    .orderBy(desc(domainChecks.checkedAt));

  const latest = new Map<string, (typeof checks)[number]>();
  for (const check of checks) {
    if (!latest.has(check.domainId)) latest.set(check.domainId, check);
  }

  return orgDomains
    .filter((d) => latest.get(d.id)?.reachable === false)
    .map((d) => ({
      id: d.id,
      domain: d.domain,
      appName: d.appName,
      error: latest.get(d.id)?.error ?? null,
    }));
}

async function loadServicesDown(now: Date): Promise<FleetAttention["servicesDown"]> {
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

