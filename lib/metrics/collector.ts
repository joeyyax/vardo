import { isMetricsEnabled } from "./config";
import { fetchAllContainerMetrics } from "./cadvisor";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeProjectDisk, storeBusinessMetric, storeOrgBusinessMetric } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getSystemDiskUsage, getPerProjectDiskUsage } from "@/lib/docker/client";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";

let timeout: ReturnType<typeof setTimeout> | null = null;
let started = false;
let tickCount = 0;

const FAST_INTERVAL_MS = 5000;   // First 20 ticks: every 5s
const NORMAL_INTERVAL_MS = 30000; // After warmup: every 30s
const WARMUP_TICKS = 20;

/**
 * Start the metrics collector.
 * Starts fast (every 5s for the first 20 ticks) then settles to every 30s.
 */
export function isCollectorRunning() {
  return started;
}

export function startCollector() {
  if (started) return;
  if (!isMetricsEnabled()) {
    console.log("[collector] Metrics collection disabled (METRICS_ENABLED=false)");
    return;
  }
  started = true;
  tickCount = 0;
  console.log("[collector] Starting metrics collection (fast warmup: 5s × 20, then 30s)");
  scheduleTick();
}

function scheduleTick() {
  if (!started) return;
  const interval = tickCount < WARMUP_TICKS ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS;
  timeout = setTimeout(async () => {
    await collect();
    tickCount++;
    scheduleTick();
  }, interval);
}

async function collect() {
  let metrics: Awaited<ReturnType<typeof fetchAllContainerMetrics>> = [];
  try {
    metrics = await fetchAllContainerMetrics();
    const results = await Promise.allSettled(
      metrics.flatMap((m) => [
        storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
          cpuPercent: m.cpuPercent,
          memoryUsage: m.memoryUsage,
          memoryLimit: m.memoryLimit,
          networkRxBytes: m.networkRxBytes,
          networkTxBytes: m.networkTxBytes,
        }, m.organizationId),
        storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId),
      ])
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.error(`[collector] ${results.length - failed} stored, ${failed} failed:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
    }
  } catch (err) {
    console.error("[collector] Error:", (err as Error).message);
  }

  // Disk write alert check: every 6th tick after warmup (~3 min at 30s interval)
  // During warmup, skip to accumulate baseline data
  if (tickCount >= WARMUP_TICKS && tickCount % 6 === 0 && metrics.length > 0) {
    try {
      await checkDiskWriteAlerts(metrics);
    } catch (err) {
      console.error("[collector] Disk write alert check error:", (err as Error).message);
    }
  }

  // Disk usage: every 10th tick during warmup, every 10th tick after (~5 min at 30s)
  const diskInterval = tickCount < WARMUP_TICKS ? 4 : 10; // Every 20s during warmup, every 5min after
  if (tickCount % diskInterval === 0) {
    try {
      const diskUsage = await getSystemDiskUsage();
      await storeDiskUsage(Date.now(), {
        images: diskUsage.images.totalSize,
        volumes: diskUsage.volumes.totalSize,
        buildCache: diskUsage.buildCache.totalSize,
        total: diskUsage.total,
      });
    } catch (err) {
      console.error("[collector] Disk error:", (err as Error).message);
    }

    try {
      const perProject = await getPerProjectDiskUsage();
      const ts = Date.now();
      await Promise.allSettled(
        Array.from(perProject.entries()).map(([name, size]) =>
          storeProjectDisk(name, ts, size)
        )
      );
    } catch (err) {
      console.error("[collector] Per-project disk error:", (err as Error).message);
    }

    // Business metrics (entity counts)
    try {
      const ts = Date.now();
      const counts = await db.execute(sql`
        SELECT 'users' AS name, COUNT(*)::text AS count FROM "user"
        UNION ALL SELECT 'organizations', COUNT(*)::text FROM "organization"
        UNION ALL SELECT 'projects', COUNT(*)::text FROM "project"
        UNION ALL SELECT 'apps', COUNT(*)::text FROM "app"
        UNION ALL SELECT 'deployments', COUNT(*)::text FROM "deployment"
        UNION ALL SELECT 'domains', COUNT(*)::text FROM "domain"
        UNION ALL SELECT 'backups', COUNT(*)::text FROM "backup"
        UNION ALL SELECT 'cronJobs', COUNT(*)::text FROM "cron_job"
      `);
      await Promise.allSettled(
        (counts as unknown as { name: string; count: string }[]).map((row) =>
          storeBusinessMetric(
            row.name as Parameters<typeof storeBusinessMetric>[0],
            ts,
            parseInt(row.count),
          )
        )
      );

      // Templates (file-based, not in DB)
      const templateList = await loadTemplates().catch(() => []);
      await storeBusinessMetric("templates", ts, templateList.length);

      // Per-org business metrics
      const orgCounts = await db.execute(sql`
        SELECT
          o.id AS org_id,
          (SELECT COUNT(*) FROM "app" a WHERE a.organization_id = o.id)::text AS apps,
          (SELECT COUNT(*) FROM "deployment" d JOIN "app" a ON d.app_id = a.id WHERE a.organization_id = o.id)::text AS deployments,
          (SELECT COUNT(*) FROM "domain" dm JOIN "app" a ON dm.app_id = a.id WHERE a.organization_id = o.id)::text AS domains,
          (SELECT COUNT(*) FROM "membership" m WHERE m.organization_id = o.id)::text AS members
        FROM "organization" o
      `);
      await Promise.allSettled(
        (orgCounts as unknown as { org_id: string; apps: string; deployments: string; domains: string; members: string }[]).flatMap((row) => [
          storeOrgBusinessMetric(row.org_id, "apps", ts, parseInt(row.apps)),
          storeOrgBusinessMetric(row.org_id, "deployments", ts, parseInt(row.deployments)),
          storeOrgBusinessMetric(row.org_id, "domains", ts, parseInt(row.domains)),
          storeOrgBusinessMetric(row.org_id, "users", ts, parseInt(row.members)),
        ])
      );
    } catch (err) {
      console.error("[collector] Business metrics error:", (err as Error).message);
    }
  }
}

// Collect immediately on start
collect();

export function stopCollector() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  started = false;
}
