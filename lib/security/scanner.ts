import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { appSecurityScans, apps } from "@/lib/db/schema";
import { and, eq, desc, inArray, ne } from "drizzle-orm";
import type { ScanAppReport, ScanFindingLine } from "@/lib/bus/events";
import { logger } from "@/lib/logger";
import { checkFileExposure } from "./file-exposure";
import { checkSecurityHeaders } from "./headers";
import { checkTls } from "./tls";
import { checkExposedPorts } from "./ports";
import type { SecurityFinding, ScanTrigger } from "./types";

const log = logger.child("security");

/** Maximum apps fetched per org during a scheduled sweep. */
const MAX_APPS_PER_ORG = 500;

type RunScanOpts = {
  appId: string;
  organizationId: string;
  trigger: ScanTrigger;
};

/** What a scan found, and what's new since the app's previous one. */
export type ScanOutcome = {
  scanId: string;
  appName: string;
  domain?: string;
  findings: SecurityFinding[];
  /** New or changed since the previous completed scan, info left out. */
  fresh: SecurityFinding[];
  /** On the previous scan, not on this one. */
  resolved: number;
};

function findingKey(f: SecurityFinding): string {
  return `${f.type}:${f.title}`;
}

/** Findings that are new, or whose severity changed, since `previous`. Info is never news. Null previous means a first scan. */
export function diffFindings(
  previous: SecurityFinding[] | null,
  current: SecurityFinding[],
): { fresh: SecurityFinding[]; resolved: number } {
  const before = new Map((previous ?? []).map((f) => [findingKey(f), f]));
  const fresh = current.filter((f) => f.severity !== "info" && before.get(findingKey(f))?.severity !== f.severity);
  const now = new Set(current.map(findingKey));
  const resolved = [...before.keys()].filter((k) => !now.has(k)).length;
  return { fresh, resolved };
}

export function findingLine(f: SecurityFinding): ScanFindingLine {
  return { severity: f.severity, title: f.title, description: f.description };
}

export function appReport(appId: string, outcome: ScanOutcome, findings: SecurityFinding[]): ScanAppReport {
  return {
    appId,
    appName: outcome.appName,
    ...(outcome.domain ? { domain: outcome.domain } : {}),
    findings: findings.map(findingLine),
    ...(outcome.resolved ? { resolved: outcome.resolved } : {}),
  };
}

function countOf(findings: SecurityFinding[], severity: SecurityFinding["severity"]): number {
  return findings.filter((f) => f.severity === severity).length;
}

async function emitScanFindings(
  organizationId: string,
  reports: { appId: string; outcome: ScanOutcome; findings: SecurityFinding[] }[],
  trigger: ScanTrigger,
  scanned?: number,
): Promise<void> {
  if (reports.length === 0) return;
  try {
    const { emit } = await import("@/lib/notifications/dispatch");
    const [first] = reports;
    const all = reports.flatMap((r) => r.findings);
    const criticalCount = countOf(all, "critical");
    const warningCount = countOf(all, "warning");
    const names = reports.map((r) => r.outcome.appName).join(", ");
    emit(organizationId, {
      type: "security.scan-findings",
      title: trigger === "manual" ? `Security scan: ${first.outcome.appName}` : `New security findings: ${names}`,
      message:
        trigger === "manual"
          ? `${all.length} finding${all.length === 1 ? "" : "s"} on ${first.outcome.appName}.`
          : `${all.length} new finding${all.length === 1 ? "" : "s"} on ${names}.`,
      appId: first.appId,
      appName: first.outcome.appName,
      scanId: first.outcome.scanId,
      criticalCount,
      warningCount,
      domain: first.outcome.domain,
      trigger,
      apps: reports.map((r) => appReport(r.appId, r.outcome, r.findings)),
      ...(scanned !== undefined ? { scanned } : {}),
    });
  } catch (err) {
    log.warn(`Failed to emit scan notification: ${err instanceof Error ? err.message : err}`);
  }
}

/** Scans an app and persists it; a manual scan reports its result, a post-deploy scan what's new. Never throws. */
export async function runSecurityScan(opts: RunScanOpts): Promise<string | null> {
  const outcome = await scanApp(opts);
  if (!outcome) return null;
  if (opts.trigger === "manual") {
    await emitScanFindings(opts.organizationId, [{ appId: opts.appId, outcome, findings: outcome.findings }], "manual");
  } else if (opts.trigger === "deploy" && outcome.fresh.length > 0) {
    await emitScanFindings(opts.organizationId, [{ appId: opts.appId, outcome, findings: outcome.fresh }], "deploy");
  }
  return outcome.scanId;
}

/** The app's last completed scan before `scanId`. */
async function previousFindings(appId: string, scanId: string): Promise<SecurityFinding[] | null> {
  const previous = await db.query.appSecurityScans.findFirst({
    where: and(eq(appSecurityScans.appId, appId), eq(appSecurityScans.status, "completed"), ne(appSecurityScans.id, scanId)),
    orderBy: [desc(appSecurityScans.startedAt)],
    columns: { findings: true },
  });
  return previous ? (previous.findings ?? []) : null;
}

/** Scans and persists one app. Null when it didn't run. */
async function scanApp(opts: RunScanOpts): Promise<ScanOutcome | null> {
  const { appId, organizationId, trigger } = opts;

  // Guard against concurrent scans for the same app.
  const existingRunning = await db.query.appSecurityScans.findFirst({
    where: and(
      eq(appSecurityScans.appId, appId),
      eq(appSecurityScans.status, "running"),
    ),
    columns: { id: true },
  });
  if (existingRunning) {
    log.info(`Scan already running for app ${appId} — skipping`);
    return null;
  }

  const scanId = nanoid();
  const startedAt = new Date();

  await db.insert(appSecurityScans).values({
    id: scanId,
    appId,
    organizationId,
    trigger,
    status: "running",
    findings: [],
    criticalCount: 0,
    warningCount: 0,
    startedAt,
  });

  try {
    // Scoped to the org for defense in depth.
    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
      columns: { id: true, name: true, displayName: true, exposedPorts: true },
      with: {
        domains: {
          columns: { domain: true, isPrimary: true, sslEnabled: true },
        },
      },
    });

    if (!app) {
      await db
        .update(appSecurityScans)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(appSecurityScans.id, scanId))
        .catch((e) => log.error(`Failed to mark scan ${scanId} as failed:`, e));
      return null;
    }

    const appName = app.displayName || app.name;
    const primaryDomain = (app.domains as { domain: string; isPrimary: boolean | null; sslEnabled: boolean | null }[])
      .find((d) => d.isPrimary)
      ?? app.domains[0] as { domain: string; isPrimary: boolean | null; sslEnabled: boolean | null } | undefined;

    const allFindings: SecurityFinding[] = [];

    if (app.exposedPorts && (app.exposedPorts as { internal: number }[]).length > 0) {
      const portFindings = checkExposedPorts(app.exposedPorts as { internal: number; external?: number }[]);
      allFindings.push(...portFindings);
    }

    if (primaryDomain) {
      const domain = primaryDomain.domain;

      const [fileFindings, headerFindings, tlsFindings] = await Promise.all([
        checkFileExposure(domain).catch((err) => {
          log.warn(`[${appName}] File exposure check failed: ${err instanceof Error ? err.message : err}`);
          return [] as SecurityFinding[];
        }),
        checkSecurityHeaders(domain).catch((err) => {
          log.warn(`[${appName}] Header check failed: ${err instanceof Error ? err.message : err}`);
          return [] as SecurityFinding[];
        }),
        checkTls(domain).catch((err) => {
          log.warn(`[${appName}] TLS check failed: ${err instanceof Error ? err.message : err}`);
          return [] as SecurityFinding[];
        }),
      ]);

      allFindings.push(...fileFindings, ...headerFindings, ...tlsFindings);
    }

    const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
    const warningCount = allFindings.filter((f) => f.severity === "warning").length;

    await db
      .update(appSecurityScans)
      .set({
        status: "completed",
        findings: allFindings,
        criticalCount,
        warningCount,
        completedAt: new Date(),
      })
      .where(eq(appSecurityScans.id, scanId))
      .catch((e) => log.error(`Failed to persist completed scan ${scanId}:`, e));

    log.info(
      `[${appName}] Scan complete — ${criticalCount} critical, ${warningCount} warning, ${allFindings.length} total findings`,
    );

    const previous = await previousFindings(appId, scanId).catch(() => undefined);
    const { fresh, resolved } = previous === undefined ? { fresh: [], resolved: 0 } : diffFindings(previous, allFindings);

    await pruneOldScans(appId);

    return { scanId, appName, domain: primaryDomain?.domain, findings: allFindings, fresh, resolved };
  } catch (err) {
    log.error(`Security scan failed for app ${appId}:`, err);
    await db
      .update(appSecurityScans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(appSecurityScans.id, scanId))
      .catch((e) => log.error(`Failed to mark scan ${scanId} as failed after error:`, e));
    return null;
  }
}

/** Keeps the 10 most recent completed scans per app. */
async function pruneOldScans(appId: string): Promise<void> {
  try {
    const recent = await db.query.appSecurityScans.findMany({
      where: eq(appSecurityScans.appId, appId),
      orderBy: [desc(appSecurityScans.startedAt)],
      columns: { id: true },
      limit: 11,
    });

    if (recent.length <= 10) return;

    const toDelete = recent.slice(10).map((s) => s.id);
    await db.delete(appSecurityScans).where(inArray(appSecurityScans.id, toDelete));
  } catch (err) {
    log.warn(`Failed to prune old scans for app ${appId}:`, err);
  }
}

/** Scans every active app with a domain in an organization, then sends one email for what's new across them. */
export async function runScheduledScans(organizationId: string): Promise<void> {
  const activeApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, organizationId),
    columns: { id: true, name: true, status: true },
    with: {
      domains: { columns: { domain: true }, limit: 1 },
    },
    limit: MAX_APPS_PER_ORG,
  });

  const scannable = activeApps.filter(
    (a) => a.status === "active" && (a.domains as { domain: string }[]).length > 0,
  );

  log.info(`Scheduled scan: ${scannable.length} apps to scan in org ${organizationId}`);

  const reports: { appId: string; outcome: ScanOutcome; findings: SecurityFinding[] }[] = [];
  let scanned = 0;
  for (const app of scannable) {
    const outcome = await scanApp({ appId: app.id, organizationId, trigger: "scheduled" }).catch((err) => {
      log.error(`Scheduled scan failed for ${app.name}:`, err);
      return null;
    });
    if (!outcome) continue;
    scanned++;
    if (outcome.fresh.length) reports.push({ appId: app.id, outcome, findings: outcome.fresh });
  }

  // Nothing new stays out of the inbox; the digest counts the scans.
  await emitScanFindings(organizationId, reports, "scheduled", scanned);
}
