import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { appSecurityScans, apps } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { checkFileExposure } from "./file-exposure";
import { checkSecurityHeaders } from "./headers";
import { checkTls } from "./tls";
import { checkExposedPorts } from "./ports";
import type { SecurityFinding, ScanTrigger } from "./types";

const log = logger.child("security");

type RunScanOpts = {
  appId: string;
  organizationId: string;
  trigger: ScanTrigger;
};

/**
 * Run a full security scan for an app. Persists the scan record and emits
 * a notification if critical findings are found.
 *
 * Safe to call fire-and-forget — errors are caught internally.
 */
export async function runSecurityScan(opts: RunScanOpts): Promise<string | null> {
  const { appId, organizationId, trigger } = opts;

  const scanId = nanoid();
  const startedAt = new Date();

  // Create the scan record in "running" state
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
    // Load app with domains and exposed ports
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
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
        .where(eq(appSecurityScans.id, scanId));
      return null;
    }

    const appName = app.displayName || app.name;
    const primaryDomain = (app.domains as { domain: string; isPrimary: boolean | null; sslEnabled: boolean | null }[])
      .find((d) => d.isPrimary)
      ?? app.domains[0] as { domain: string; isPrimary: boolean | null; sslEnabled: boolean | null } | undefined;

    const allFindings: SecurityFinding[] = [];

    // Port exposure — static check, always run
    if (app.exposedPorts && (app.exposedPorts as { internal: number }[]).length > 0) {
      const portFindings = checkExposedPorts(app.exposedPorts as { internal: number; external?: number }[]);
      allFindings.push(...portFindings);
    }

    // Network-based checks — only if the app has a domain
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

    // Persist completed scan
    await db
      .update(appSecurityScans)
      .set({
        status: "completed",
        findings: allFindings,
        criticalCount,
        warningCount,
        completedAt: new Date(),
      })
      .where(eq(appSecurityScans.id, scanId));

    log.info(
      `[${appName}] Scan complete — ${criticalCount} critical, ${warningCount} warning, ${allFindings.length} total findings`,
    );

    // Emit notification for critical or warning findings
    if (criticalCount > 0 || warningCount > 0) {
      try {
        const { emit } = await import("@/lib/notifications/dispatch");
        const parts: string[] = [];
        if (criticalCount > 0) parts.push(`${criticalCount} critical`);
        if (warningCount > 0) parts.push(`${warningCount} warning`);

        emit(organizationId, {
          type: "security.scan-findings",
          title: `Security findings: ${appName}`,
          message: `${parts.join(", ")} finding${allFindings.length === 1 ? "" : "s"} detected on ${appName}.`,
          appId,
          appName,
          scanId,
          criticalCount,
          warningCount,
          domain: primaryDomain?.domain,
        });
      } catch (err) {
        log.warn(`[${appName}] Failed to emit scan notification: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Prune old scans — keep last 10 per app
    await pruneOldScans(appId);

    return scanId;
  } catch (err) {
    log.error(`Security scan failed for app ${appId}:`, err);
    await db
      .update(appSecurityScans)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(appSecurityScans.id, scanId))
      .catch(() => {});
    return null;
  }
}

/**
 * Keep only the most recent 10 completed scans per app.
 */
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
    for (const id of toDelete) {
      await db.delete(appSecurityScans).where(eq(appSecurityScans.id, id));
    }
  } catch {
    // Pruning failure is non-fatal
  }
}

/**
 * Run security scans for all active apps in an organization that have domains.
 * Used by the daily scheduled scan.
 */
export async function runScheduledScans(organizationId: string): Promise<void> {
  const activeApps = await db.query.apps.findMany({
    where: eq(apps.organizationId, organizationId),
    columns: { id: true, name: true, status: true },
    with: {
      domains: { columns: { domain: true }, limit: 1 },
    },
  });

  const scannable = activeApps.filter(
    (a) => a.status === "active" && (a.domains as { domain: string }[]).length > 0,
  );

  log.info(`Scheduled scan: ${scannable.length} apps to scan in org ${organizationId}`);

  for (const app of scannable) {
    await runSecurityScan({ appId: app.id, organizationId, trigger: "scheduled" }).catch((err) => {
      log.error(`Scheduled scan failed for ${app.name}:`, err);
    });
  }
}
