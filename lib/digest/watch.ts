// A watched project's detail for the digest: each site's numbers from the recap collector over the digest window.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, domainCertChecks, domains, projects, projectWatches } from "@/lib/db/schema";
import type { AppRecap, DigestWatchedProject } from "@/lib/bus/events";
import { collectRecap } from "@/lib/recaps/collect";
import { hourOfDay, loadHistoryRows, summarizeHours } from "@/lib/metrics/history";
import type { DigestWindow } from "./window";

/** Project ids each user watches in the org. */
export async function watchesByUser(orgId: string, userIds: string[]): Promise<Map<string, string[]>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ userId: projectWatches.userId, projectId: projectWatches.projectId })
    .from(projectWatches)
    .innerJoin(projects, eq(projects.id, projectWatches.projectId))
    .where(and(eq(projects.organizationId, orgId), inArray(projectWatches.userId, userIds)));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.projectId]);
  return out;
}

/** One project's detail. Null when it's gone or has no apps. `sizes` is the host's volume sizes, read once per pass. */
export async function collectWatchedProject(
  orgId: string,
  projectId: string,
  window: DigestWindow,
  sizes: Map<string, number>,
): Promise<DigestWatchedProject | null> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
    columns: { id: true, name: true, displayName: true },
  });
  if (!project) return null;
  const projectApps = await db.query.apps.findMany({
    where: and(eq(apps.projectId, projectId), isNull(apps.parentAppId)),
    columns: { id: true },
  });
  if (!projectApps.length) return null;
  const appIds = projectApps.map((a) => a.id);
  const history = { from: window.since, to: window.until };

  const recaps: AppRecap[] = [];
  for (const app of projectApps) {
    const recap = await collectRecap({ appId: app.id, organizationId: orgId, kind: "30d", deployedAt: window.since }, window.until, window.timeZone, sizes);
    if (recap) recaps.push(recap);
  }

  const [rows, domainRows] = await Promise.all([
    loadHistoryRows(orgId, history, appIds),
    db
      .select({ appId: domains.appId, domain: domains.domain, isPrimary: domains.isPrimary, expiresAt: domainCertChecks.expiresAt })
      .from(domains)
      .leftJoin(domainCertChecks, eq(domainCertChecks.domainId, domains.id))
      .where(and(inArray(domains.appId, appIds), eq(domains.enabled, true))),
  ]);

  // Uptime and response combine across sites: checks add up and histograms merge.
  const summary = summarizeHours(rows, history);
  const withNetwork = new Set(recaps.filter((r) => r.network).map((r) => r.appId));
  const hours = hourOfDay(rows.filter((r) => withNetwork.has(r.appId)), history, window.timeZone).map((h) => (h.rxBytes ?? 0) + (h.txBytes ?? 0));

  const primary: Record<string, string> = {};
  for (const d of domainRows) if (d.appId && (d.isPrimary || !primary[d.appId])) primary[d.appId] = d.domain;
  const expiries = domainRows.flatMap((d) => (d.expiresAt ? [d.expiresAt.getTime()] : []));

  return {
    projectId: project.id,
    name: project.displayName || project.name,
    apps: recaps,
    domains: primary,
    uptime: summary.uptime
      ? { ratio: summary.uptime.ratio, downMinutes: Math.round((1 - summary.uptime.ratio) * summary.uptime.hoursChecked * 60) }
      : null,
    response: summary.response ? { p50: summary.response.p50, p95: summary.response.p95 } : null,
    hours,
    certs: { count: expiries.length, nextExpiresAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null },
  };
}
