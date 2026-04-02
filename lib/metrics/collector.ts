import { logger } from "@/lib/logger";
import { isMetricsEnabled, initMetricsProvider } from "./config";
import { fetchAllMetrics } from "./provider";
import { storeMetrics, storeDiskUsage, storeDiskWrite, storeGpuMetrics, storeProjectDisk, storeBusinessMetric, storeOrgBusinessMetric } from "./store";
import { checkDiskWriteAlerts } from "./disk-write-alerts";
import { getSystemDiskUsage, getPerProjectDiskUsage } from "@/lib/docker/client";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";

const log = logger.child("collector");

let timeout: ReturnType<typeof setTimeout> | null = null;
let started = false;
let tickCount = 0;
let consecutiveFailures = 0;
const DEGRADED_THRESHOLD = 3; // mark integration degraded after 3 consecutive failures

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

export async function startCollector() {
  if (started) return;
  await initMetricsProvider(); // ensure provider is ready
  if (!isMetricsEnabled()) {
    log.info("Metrics collection disabled — no provider configured");
    return;
  }
  started = true;
  tickCount = 0;
  log.info("Starting metrics collection (fast warmup: 5s × 20, then 30s)");
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
  let metrics: Awaited<ReturnType<typeof fetchAllMetrics>> = [];
  try {
    metrics = await fetchAllMetrics();
    const results = await Promise.allSettled(
      metrics.flatMap((m) => {
        const ops = [
          storeMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            cpuPercent: m.cpuPercent,
            memoryUsage: m.memoryUsage,
            memoryLimit: m.memoryLimit,
            networkRxBytes: m.networkRxBytes,
            networkTxBytes: m.networkTxBytes,
          }, m.organizationId),
          storeDiskWrite(m.projectName, m.containerId, m.containerName, m.timestamp, m.diskWriteBytes, m.organizationId),
        ];
        // Only store GPU metrics when a GPU is present for this container
        if (m.gpuMemoryTotal > 0) {
          ops.push(storeGpuMetrics(m.projectName, m.containerId, m.containerName, m.timestamp, {
            gpuUtilization: m.gpuUtilization,
            gpuMemoryUsed: m.gpuMemoryUsed,
            gpuMemoryTotal: m.gpuMemoryTotal,
            gpuTemperature: m.gpuTemperature,
          }, m.organizationId));
        }
        return ops;
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      log.error(`${results.length - failed} stored, ${failed} failed:`, (results.find((r) => r.status === "rejected") as PromiseRejectedResult)?.reason);
    }

    // Recovered — mark integration connected if it was degraded
    if (consecutiveFailures >= DEGRADED_THRESHOLD) {
      updateIntegrationHealth("connected");
    }
    consecutiveFailures = 0;
  } catch (err) {
    log.error("Error:", (err as Error).message);
    consecutiveFailures++;
    if (consecutiveFailures === DEGRADED_THRESHOLD) {
      updateIntegrationHealth("degraded");
    }
  }

  // Disk write alert check: every 6th tick after warmup (~3 min at 30s interval)
  // During warmup, skip to accumulate baseline data
  if (tickCount >= WARMUP_TICKS && tickCount % 6 === 0 && metrics.length > 0) {
    try {
      await checkDiskWriteAlerts(metrics);
    } catch (err) {
      log.error("Disk write alert check error:", (err as Error).message);
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
      log.error("Disk error:", (err as Error).message);
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
      log.error("Per-project disk error:", (err as Error).message);
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

      // Per-org business metrics — LEFT JOIN aggregations instead of correlated subqueries
      const orgCounts = await db.execute(sql`
        SELECT
          o.id AS org_id,
          COALESCE(ac.cnt, 0)::text AS apps,
          COALESCE(dc.cnt, 0)::text AS deployments,
          COALESCE(dmc.cnt, 0)::text AS domains,
          COALESCE(mc.cnt, 0)::text AS members
        FROM "organization" o
        LEFT JOIN (SELECT organization_id, COUNT(*) AS cnt FROM "app" GROUP BY 1) ac ON ac.organization_id = o.id
        LEFT JOIN (SELECT a.organization_id, COUNT(*) AS cnt FROM "deployment" d JOIN "app" a ON d.app_id = a.id GROUP BY 1) dc ON dc.organization_id = o.id
        LEFT JOIN (SELECT a.organization_id, COUNT(*) AS cnt FROM "domain" dm JOIN "app" a ON dm.app_id = a.id GROUP BY 1) dmc ON dmc.organization_id = o.id
        LEFT JOIN (SELECT organization_id, COUNT(*) AS cnt FROM "membership" GROUP BY 1) mc ON mc.organization_id = o.id
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
      log.error("Business metrics error:", (err as Error).message);
    }
  }
}

export function stopCollector() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  started = false;
}

/** Update metrics integration status (best-effort, non-blocking). */
function updateIntegrationHealth(status: "connected" | "degraded") {
  import("@/lib/integrations")
    .then(({ getIntegration, updateIntegrationStatus }) =>
      getIntegration("metrics").then((integration) => {
        if (integration && integration.status !== "disconnected") {
          return updateIntegrationStatus("metrics", status);
        }
      })
    )
    .then(() => log.info(`Metrics integration → ${status}`))
    .catch(() => {}); // best-effort
}
