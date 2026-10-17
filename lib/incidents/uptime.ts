// Confirmed monitor outages and disagreements as incidents: opened once while the monitor is down or degraded, resolved when it recovers.

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { incidents } from "@/lib/db/schema";
import { incidentKey } from "./key";
import { emitSystemIncident, resolveSystemIncident } from "./system";

export const UPTIME_INCIDENT = "uptime.down";

export type UptimeOutage = {
  /** Monitor id. */
  about: string;
  title: string;
  /** Orgs that hear about it: the owning org, or the operator's for an instance monitor. */
  orgIds: string[];
  appId?: string;
  /** Critical unless given. */
  severity?: "critical" | "warning";
};

async function isOpen(orgId: string, about: string): Promise<boolean> {
  const row = await db.query.incidents.findFirst({
    where: and(eq(incidents.organizationId, orgId), eq(incidents.key, incidentKey(UPTIME_INCIDENT, about)), eq(incidents.state, "open")),
    columns: { id: true },
  });
  return !!row;
}

/** Opens the incident where none is open. Returns whether anything opened. */
export async function openUptimeIncident(outage: UptimeOutage, detail: string): Promise<boolean> {
  const fresh: string[] = [];
  for (const orgId of outage.orgIds) if (!(await isOpen(orgId, outage.about))) fresh.push(orgId);
  if (fresh.length === 0) return false;
  await emitSystemIncident(
    fresh,
    { type: "system.service-down", title: outage.title, message: detail, service: outage.about, description: outage.title },
    { kind: UPTIME_INCIDENT, about: outage.about, title: outage.title, severity: outage.severity ?? "critical", appId: outage.appId },
  );
  return true;
}

/** Resolves the incident where one is open. */
export async function resolveUptimeIncident(outage: Pick<UptimeOutage, "about" | "orgIds">, recovered: string): Promise<void> {
  await resolveSystemIncident(outage.orgIds, UPTIME_INCIDENT, outage.about, recovered);
}

export type UptimeIncident = { id: string; openedAt: Date; resolvedAt: Date | null };

/** Incidents for one monitor in an org since `since`, newest first. */
export async function listUptimeIncidents(orgId: string, about: string, since: Date): Promise<UptimeIncident[]> {
  return db
    .select({ id: incidents.id, openedAt: incidents.openedAt, resolvedAt: incidents.resolvedAt })
    .from(incidents)
    .where(and(eq(incidents.organizationId, orgId), eq(incidents.key, incidentKey(UPTIME_INCIDENT, about)), gte(incidents.openedAt, since)))
    .orderBy(desc(incidents.openedAt));
}
