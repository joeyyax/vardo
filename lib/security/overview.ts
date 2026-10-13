// Security overview across apps: findings from each app's latest completed scan.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSecurityScans, apps, organizations } from "@/lib/db/schema";
import type { SecurityFinding } from "@/lib/db/schema/security";

/** Apps with their latest completed scan. */
export type AppSecurityOverview = {
  appId: string;
  appName: string;
  appSlug: string;
  organizationId: string;
  organizationName: string;
  scanId: string;
  scannedAt: Date;
  criticalCount: number;
  warningCount: number;
  findings: SecurityFinding[];
};

export type SecurityOverview = {
  /** Apps with at least one warning or critical finding; top `topN` included. */
  worst: AppSecurityOverview[];
  /** Counts across every app's latest completed scan. */
  totals: { apps: number; critical: number; warning: number; info: number };
  /** Worst-apps slice cap. */
  topN: number;
};

export type LatestScan = { appId: string; scanId: string; scannedAt: Date };
export type ScanRow = {
  id: string;
  criticalCount: number;
  warningCount: number;
  findings: SecurityFinding[] | null;
  scannedAt: Date;
};
export type AppRow = { id: string; appName: string; appSlug: string; organizationId: string };

/** Pure: builds the SecurityOverview from the inputs the DB queries returned. */
export function buildOverview(opts: {
  scans: LatestScan[];
  scanRows: ScanRow[];
  appRows: AppRow[];
  orgNameById: Record<string, string>;
  topN: number;
}): SecurityOverview {
  const { scans, scanRows, appRows, orgNameById, topN } = opts;
  if (scans.length === 0) {
    return { worst: [], totals: { apps: 0, critical: 0, warning: 0, info: 0 }, topN };
  }

  const scanById: Record<string, ScanRow> = Object.fromEntries(scanRows.map((s) => [s.id, s]));
  const appById: Record<string, AppRow> = Object.fromEntries(appRows.map((a) => [a.id, a]));

  const totals = scanRows.reduce(
    (acc, r) => {
      const findings = (r.findings ?? []) as SecurityFinding[];
      for (const f of findings) {
        if (f.severity === "critical") acc.critical += 1;
        else if (f.severity === "warning") acc.warning += 1;
        else acc.info += 1;
      }
      return acc;
    },
    { apps: scanRows.length, critical: 0, warning: 0, info: 0 },
  );

  const worst: AppSecurityOverview[] = [];
  for (const s of scans) {
    const app = appById[s.appId];
    if (!app) continue;
    const scan = scanById[s.scanId];
    if (!scan) continue;
    worst.push({
      appId: app.id,
      appName: app.appName,
      appSlug: app.appSlug,
      organizationId: app.organizationId,
      organizationName: orgNameById[app.organizationId] ?? "",
      scanId: scan.id,
      scannedAt: scan.scannedAt,
      criticalCount: scan.criticalCount,
      warningCount: scan.warningCount,
      findings: (scan.findings ?? []) as SecurityFinding[],
    });
  }

  worst.sort((a, b) => {
    if (b.criticalCount !== a.criticalCount) return b.criticalCount - a.criticalCount;
    if (b.warningCount !== a.warningCount) return b.warningCount - a.warningCount;
    return b.scannedAt.getTime() - a.scannedAt.getTime();
  });

  const slice = worst.filter((a) => a.criticalCount > 0 || a.warningCount > 0).slice(0, topN);
  return { worst: slice, totals, topN };
}

/** Aggregated findings across every top-level app's most recent completed scan. */
export async function securityOverview(opts: { topN?: number } = {}): Promise<SecurityOverview> {
  const topN = opts.topN ?? 2;

  // DISTINCT ON keeps the newest completed scan per app in a single query.
  const scans = await db
    .selectDistinctOn([appSecurityScans.appId], {
      appId: appSecurityScans.appId,
      scanId: appSecurityScans.id,
      scannedAt: appSecurityScans.startedAt,
    })
    .from(appSecurityScans)
    .where(eq(appSecurityScans.status, "completed"))
    .orderBy(appSecurityScans.appId, desc(appSecurityScans.startedAt));
  if (scans.length === 0) {
    return { worst: [], totals: { apps: 0, critical: 0, warning: 0, info: 0 }, topN };
  }

  const scanIds = scans.map((s) => s.scanId);
  const appIds = scans.map((s) => s.appId);

  const [scanRows, appRows] = await Promise.all([
    db
      .select({
        id: appSecurityScans.id,
        criticalCount: appSecurityScans.criticalCount,
        warningCount: appSecurityScans.warningCount,
        findings: appSecurityScans.findings,
        scannedAt: appSecurityScans.startedAt,
      })
      .from(appSecurityScans)
      .where(inArray(appSecurityScans.id, scanIds)),
    db
      .select({ id: apps.id, appName: apps.displayName, appSlug: apps.name, organizationId: apps.organizationId })
      .from(apps)
      .innerJoin(organizations, eq(apps.organizationId, organizations.id))
      .where(and(inArray(apps.id, appIds), isNull(apps.parentAppId), eq(organizations.isSystemManaged, false))),
  ]);

  const orgRows = appRows.length
    ? await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, appRows.map((a) => a.organizationId)))
    : [];
  const orgNameById: Record<string, string> = Object.fromEntries(orgRows.map((r) => [r.id, r.name]));

  return buildOverview({ scans, scanRows, appRows, orgNameById, topN });
}