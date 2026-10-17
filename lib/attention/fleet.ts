import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, domains, systemSettings } from "@/lib/db/schema";
import { uptimeClient } from "@/lib/uptime/client";
import type { ReviewItem } from "@/lib/uptime/types";
import {
  ALERT_STATE_KEY,
  selectActiveServiceAlerts,
  type PersistedAlertEntry,
  type ServiceDown,
} from "./service-alerts";

export type FleetAttention = {
  unreachableDomains: { id: string; domain: string; appName: string | null; error: string | null }[];
  /** Monitors waiting on an answer about what counts as up. */
  monitorReviews: ReviewItem[];
};

/** Domains whose most recent check failed. */
export async function getFleetAttention(orgId: string): Promise<FleetAttention> {
  const [unreachableDomains, monitorReviews] = await Promise.all([loadUnreachableDomains(orgId), uptimeClient.listReviews(orgId).catch(() => [])]);
  return { unreachableDomains, monitorReviews };
}

async function loadUnreachableDomains(orgId: string): Promise<FleetAttention["unreachableDomains"]> {
  // Only running apps, so a retired app's last failed check doesn't linger.
  const orgDomains = await db
    .select({ id: domains.id, domain: domains.domain, appName: apps.name })
    .from(domains)
    .leftJoin(apps, eq(apps.id, domains.appId))
    .where(and(eq(apps.organizationId, orgId), eq(apps.status, "active"), eq(domains.enabled, true)));

  if (orgDomains.length === 0) return [];

  const reachability = await uptimeClient.domainReachability(orgId, orgDomains.map((d) => d.id));
  const byDomain = new Map(reachability.map((r) => [r.domainId, r]));

  return orgDomains
    .filter((d) => byDomain.get(d.id)?.confirmedUnreachable)
    .map((d) => ({ id: d.id, domain: d.domain, appName: d.appName, error: byDomain.get(d.id)?.error ?? null }));
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
