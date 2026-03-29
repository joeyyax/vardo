import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import nextPkg from "next/package.json";
import { getGitHubAppConfig } from "@/lib/system-settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
  error?: string;
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

const MAX_ERROR_LENGTH = 120;

/**
 * Strip potentially sensitive info from raw library error messages before
 * surfacing them in the API response or admin UI. Removes connection strings,
 * IP addresses with ports, and pg role/database/user names.
 */
function sanitizeError(message: string): string {
  return message
    .replace(/redis:\/\/\S+/gi, "[url]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[host]")
    .replace(/\blocalhost(?::\d+)?\b/gi, "[host]")
    .replace(/\b(role|database|user) "[^"]+"/gi, "$1 [name]")
    .slice(0, MAX_ERROR_LENGTH);
}

async function checkService(
  name: string,
  description: string,
  check: () => Promise<void>,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await check();
    return { name, description, status: "healthy", latencyMs: Date.now() - start };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const error = sanitizeError(raw);
    return { name, description, status: "unhealthy", latencyMs: Date.now() - start, error };
  }
}

async function checkLoki(): Promise<ServiceStatus> {
  const url = process.env.LOKI_URL || "http://localhost:7400";
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

async function checkWireguard(): Promise<ServiceStatus | null> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  const meshEnabled = await isFeatureEnabledAsync("mesh");
  if (!meshEnabled) return null;

  return checkService("WireGuard", "Mesh network tunnels", async () => {
    const { isWireguardRunning } = await import("@/lib/mesh/wireguard");
    const running = await isWireguardRunning();
    if (!running) throw new Error("not running");
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
    const { getSystemInfo } = await import("@/lib/docker/client");
    const { getLatestSnapshot } = await import("@/lib/metrics/broadcast");

    // Use cached metrics snapshot (no cAdvisor call) + system info (fast, ~20ms)
    const [systemInfo, metrics] = await Promise.all([
      getSystemInfo().catch(() => null),
      Promise.resolve(getLatestSnapshot() || []),
    ]);

    // CPU — aggregate across all containers
    if (systemInfo && metrics.length > 0) {
      const totalCpu = metrics.reduce((s, m) => s + m.cpuPercent, 0);
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
      const totalMemUsed = (metrics || []).reduce((s, m) => s + m.memoryUsage, 0);
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

    // Disk — use df directly (fast, ~50ms). Skip docker system df (3s+).
    try {
      const { execSync } = await import("child_process");
      const dfOutput = execSync("df -B1 /var/lib/docker 2>/dev/null || df -B1 / 2>/dev/null", {
        encoding: "utf-8",
        timeout: 3000,
      });
      const lines = dfOutput.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const diskTotal = parseInt(parts[1]) || 0;
        const diskUsed = parseInt(parts[2]) || 0;
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
      // df not available
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
        const url = process.env.REDIS_URL || "redis://localhost:7200";
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
        const url = process.env.CADVISOR_URL || "http://localhost:7300";
        const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`${res.status}`);
      }),
      checkLoki(),
      checkTraefik(),
      checkWireguard(),
    ]),
    getResourceStatuses(),
  ]);

  const githubConfig = await getGitHubAppConfig();
  const auth: AuthConfig = {
    passkeys: true,
    magicLink: true,
    github: !!(githubConfig?.clientId && githubConfig?.clientSecret),
    passwords: false,
    twoFactor: true,
  };

  const mem = process.memoryUsage();
  const nextVersion: string = nextPkg.version ?? "unknown";

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

  return {
    services: services.filter((s): s is ServiceStatus => s !== null),
    resources,
    runtime,
    auth,
  };
}
