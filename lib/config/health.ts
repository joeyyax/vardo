import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
};

export type ResourceStatus = {
  name: string;
  current: number;
  total: number;
  percent: number;
  unit: string;
  status: "ok" | "warning" | "critical";
};

export type AuthConfig = {
  passkeys: boolean;
  magicLink: boolean;
  github: boolean;
  passwords: boolean;
  twoFactor: boolean;
};

export type RuntimeInfo = {
  nodeVersion: string;
  nextVersion: string;
  platform: string;
  arch: string;
  uptime: number; // seconds
  memoryUsage: number; // bytes (RSS)
  memoryHeapUsed: number; // bytes
  memoryHeapTotal: number; // bytes
  pid: number;
};

export type SystemHealth = {
  services: ServiceStatus[];
  resources: ResourceStatus[];
  runtime: RuntimeInfo;
  auth: AuthConfig;
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  cpu: { warning: 80, critical: 95 },
  memory: { warning: 80, critical: 95 },
  disk: { warning: 80, critical: 90 },
};

// ---------------------------------------------------------------------------
// Service checks
// ---------------------------------------------------------------------------

async function checkService(
  name: string,
  description: string,
  check: () => Promise<void>,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await check();
    return { name, description, status: "healthy", latencyMs: Date.now() - start };
  } catch {
    return { name, description, status: "unhealthy", latencyMs: Date.now() - start };
  }
}

async function checkLoki(): Promise<ServiceStatus> {
  const url = process.env.LOKI_URL || "http://localhost:3100";
  if (!url) {
    return { name: "Loki", description: "Log aggregation", status: "unconfigured" };
  }
  return checkService("Loki", "Log aggregation", async () => {
    const res = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`${res.status}`);
  });
}

async function checkTraefik(): Promise<ServiceStatus> {
  return checkService("Traefik", "Reverse proxy and SSL", async () => {
    const res = await fetch("http://localhost:8080/api/overview", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`${res.status}`);
  });
}

// ---------------------------------------------------------------------------
// Resource checks
// ---------------------------------------------------------------------------

function resourceStatus(percent: number, thresholds: { warning: number; critical: number }): "ok" | "warning" | "critical" {
  if (percent >= thresholds.critical) return "critical";
  if (percent >= thresholds.warning) return "warning";
  return "ok";
}

async function getResourceStatuses(): Promise<ResourceStatus[]> {
  const resources: ResourceStatus[] = [];

  try {
    const { getSystemInfo, getSystemDiskUsage } = await import("@/lib/docker/client");
    const { fetchAllContainerMetrics } = await import("@/lib/metrics/cadvisor");

    const [systemInfo, diskUsage, metrics] = await Promise.all([
      getSystemInfo().catch(() => null),
      getSystemDiskUsage().catch(() => null),
      fetchAllContainerMetrics().catch(() => []),
    ]);

    // CPU — aggregate across all containers
    if (systemInfo && metrics.length > 0) {
      const totalCpu = metrics.reduce((s, m) => s + m.cpuPercent, 0);
      // Normalize to total available CPU (100% per core)
      const maxCpu = systemInfo.cpus * 100;
      const cpuPercent = maxCpu > 0 ? (totalCpu / maxCpu) * 100 : 0;
      resources.push({
        name: "CPU",
        current: Math.round(totalCpu * 100) / 100,
        total: maxCpu,
        percent: Math.round(cpuPercent * 10) / 10,
        unit: "%",
        status: resourceStatus(cpuPercent, THRESHOLDS.cpu),
      });
    }

    // Memory
    if (systemInfo) {
      const totalMemUsed = metrics.reduce((s, m) => s + m.memoryUsage, 0);
      const memPercent = systemInfo.memoryTotal > 0
        ? (totalMemUsed / systemInfo.memoryTotal) * 100
        : 0;
      resources.push({
        name: "Memory",
        current: totalMemUsed,
        total: systemInfo.memoryTotal,
        percent: Math.round(memPercent * 10) / 10,
        unit: "bytes",
        status: resourceStatus(memPercent, THRESHOLDS.memory),
      });
    }

    // Disk
    if (diskUsage) {
      // Use Docker's reported total vs used. Estimate capacity from image sizes.
      // For a more accurate reading, we'd need host filesystem info.
      // Use a reasonable heuristic: if total usage > 80% of available docker storage
      const { execSync } = await import("child_process");
      let diskTotal = 0;
      let diskUsed = 0;
      try {
        const dfOutput = execSync("df -B1 /var/lib/docker 2>/dev/null || df -B1 / 2>/dev/null", {
          encoding: "utf-8",
          timeout: 3000,
        });
        const lines = dfOutput.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          diskTotal = parseInt(parts[1]) || 0;
          diskUsed = parseInt(parts[2]) || 0;
        }
      } catch {
        // Fallback to Docker-reported sizes
        diskUsed = diskUsage.total;
        diskTotal = diskUsage.total * 2; // rough estimate
      }

      if (diskTotal > 0) {
        const diskPercent = (diskUsed / diskTotal) * 100;
        resources.push({
          name: "Disk",
          current: diskUsed,
          total: diskTotal,
          percent: Math.round(diskPercent * 10) / 10,
          unit: "bytes",
          status: resourceStatus(diskPercent, THRESHOLDS.disk),
        });
      }
    }
  } catch {
    // Resource checks are best-effort
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Check health of all infrastructure services, resource usage, and auth config.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const [services, resources] = await Promise.all([
    Promise.all([
      checkService("PostgreSQL", "Primary database", async () => {
        await db.execute(sql`SELECT 1`);
      }),
      checkService("Redis", "Cache and time-series metrics", async () => {
        const Redis = (await import("ioredis")).default;
        const url = process.env.REDIS_URL || "redis://localhost:6379";
        const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
        await redis.ping();
        redis.disconnect();
      }),
      checkService("Docker", "Container runtime", async () => {
        const { isDockerAvailable } = await import("@/lib/docker/client");
        const ok = await isDockerAvailable();
        if (!ok) throw new Error("unreachable");
      }),
      checkService("cAdvisor", "Container metrics", async () => {
        const url = process.env.CADVISOR_URL || "http://localhost:8081";
        const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`${res.status}`);
      }),
      checkLoki(),
      checkTraefik(),
    ]),
    getResourceStatuses(),
  ]);

  const auth: AuthConfig = {
    passkeys: true,
    magicLink: true,
    github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    passwords: false,
    twoFactor: true,
  };

  const mem = process.memoryUsage();
  let nextVersion = "unknown";
  try { nextVersion = require("next/package.json").version; } catch { /* skip */ }

  const runtime: RuntimeInfo = {
    nodeVersion: process.version,
    nextVersion,
    platform: process.platform,
    arch: process.arch,
    uptime: Math.floor(process.uptime()),
    memoryUsage: mem.rss,
    memoryHeapUsed: mem.heapUsed,
    memoryHeapTotal: mem.heapTotal,
    pid: process.pid,
  };

  return { services, resources, runtime, auth };
}
