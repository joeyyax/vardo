import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import nextPkg from "next/package.json";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { formatDuration } from "@/lib/ui/service-health";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
  error?: string;
  /** ISO timestamp of the probe that produced this status. */
  checkedAt: string;
  /** Bound on the probe, so a slow service reads differently from a dead one. */
  timeoutMs: number;
  /** Logs page for the service, when the instance runs it as an app. */
  logsHref?: string;
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
export function sanitizeError(message: string): string {
  return message
    .replace(/redis:\/\/\S+/gi, "[url]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[host]")
    .replace(/\blocalhost(?::\d+)?\b/gi, "[host]")
    .replace(/\b(role|database|user) "[^"]+"/gi, "$1 [name]")
    .slice(0, MAX_ERROR_LENGTH);
}

/** `fetch` reports "fetch failed" and puts the reason on the cause. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause instanceof Error) return `${err.message}: ${err.cause.message}`;
  return err.message;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * What the operator reads on a failed probe. A probe that ran out its budget
 * says so — "too slow" and "refused the connection" call for different work.
 */
export function probeErrorText(err: unknown, timeoutMs: number): string {
  return isTimeout(err)
    ? `Timed out after ${formatDuration(timeoutMs)}`
    : sanitizeError(describeError(err));
}

type Probe = {
  name: string;
  description: string;
  /** Rejects on failure. Timing and error shaping belong to the runner. */
  run: (timeoutMs: number) => Promise<void>;
  timeoutMs: number;
  /** System-managed app carrying this service's logs. */
  logsApp?: string;
  /** Probed only when this resolves true. */
  applies?: () => Promise<boolean>;
};

async function httpProbe(url: string, timeoutMs: number): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export const SERVICE_PROBES: Probe[] = [
  {
    name: "PostgreSQL",
    description: "Primary database",
    timeoutMs: 5000,
    run: async () => {
      await db.execute(sql`SELECT 1`);
    },
  },
  {
    name: "Redis",
    description: "Cache and time-series metrics",
    timeoutMs: 2000,
    run: async (timeoutMs) => {
      const Redis = (await import("ioredis")).default;
      const url = process.env.REDIS_URL || "redis://localhost:7200";
      const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: timeoutMs });
      try {
        await redis.ping();
      } finally {
        redis.disconnect();
      }
    },
  },
  {
    name: "Docker",
    description: "Container runtime",
    timeoutMs: 5000,
    run: async () => {
      const { isDockerAvailable } = await import("@/lib/docker/client");
      const ok = await isDockerAvailable();
      if (!ok) throw new Error("unreachable");
    },
  },
  {
    name: "cAdvisor",
    description: "Container metrics",
    timeoutMs: 2000,
    logsApp: "cadvisor",
    run: (timeoutMs) =>
      httpProbe(`${process.env.CADVISOR_URL || "http://localhost:7300"}/healthz`, timeoutMs),
  },
  {
    name: "Loki",
    description: "Log aggregation",
    timeoutMs: 2000,
    logsApp: "loki",
    run: (timeoutMs) =>
      httpProbe(`${process.env.LOKI_URL || "http://localhost:7400"}/ready`, timeoutMs),
  },
  {
    name: "Traefik",
    description: "Reverse proxy and SSL",
    timeoutMs: 2000,
    // Overridable: localhost is the frontend container itself, not the proxy.
    run: (timeoutMs) =>
      httpProbe(`${process.env.TRAEFIK_URL || "http://localhost:8080"}/api/overview`, timeoutMs),
  },
  {
    name: "WireGuard",
    description: "Mesh network tunnels",
    timeoutMs: 5000,
    applies: async () => {
      const { isFeatureEnabledAsync } = await import("@/lib/config/features");
      return isFeatureEnabledAsync("mesh");
    },
    run: async () => {
      const { isWireguardRunning } = await import("@/lib/mesh/wireguard");
      const running = await isWireguardRunning();
      if (!running) throw new Error("not running");
    },
  },
];

/** Run one probe, bounding it at its own timeout. */
async function runProbe(probe: Probe): Promise<ServiceStatus> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const base = { name: probe.name, description: probe.description, timeoutMs: probe.timeoutMs };

  // A probe that loses the race still settles later, so it keeps a handler.
  const running = probe.run(probe.timeoutMs);
  running.catch(() => {});

  try {
    await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error("timeout");
          err.name = "TimeoutError";
          reject(err);
        }, probe.timeoutMs);
      }),
    ]);
    return {
      ...base,
      status: "healthy",
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...base,
      status: "unhealthy",
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
      error: probeErrorText(err, probe.timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-probe a single service by name. Returns null when the name is unknown or
 * the service does not apply to this instance.
 */
export async function checkServiceByName(name: string): Promise<ServiceStatus | null> {
  const probe = SERVICE_PROBES.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!probe) return null;
  if (probe.applies && !(await probe.applies())) return null;

  const [status, logsHrefs] = await Promise.all([runProbe(probe), resolveLogsHrefs()]);
  return { ...status, logsHref: logsHrefs.get(probe.name) };
}

/**
 * Logs pages for services Vardo runs as system-managed apps. Only offered when
 * the logs tab is reachable and the app belongs to the viewer's current org.
 */
async function resolveLogsHrefs(): Promise<Map<string, string>> {
  const hrefs = new Map<string, string>();
  const slugs = SERVICE_PROBES.map((p) => p.logsApp).filter((s): s is string => !!s);
  if (slugs.length === 0) return hrefs;

  try {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    const [logging, selfManagement] = await Promise.all([
      isFeatureEnabledAsync("logging"),
      isFeatureEnabledAsync("selfManagement"),
    ]);
    if (!logging || !selfManagement) return hrefs;

    // Scoped to the viewer's current org, not to any org. The route resolves a
    // slug within the active org, so an app owned by another one links to a 404.
    const { getCurrentOrg } = await import("@/lib/auth/session");
    const orgData = await getCurrentOrg();
    if (!orgData) return hrefs;

    const { apps } = await import("@/lib/db/schema");
    const { and, eq, inArray } = await import("drizzle-orm");
    const rows = await db
      .select({ name: apps.name })
      .from(apps)
      .where(
        and(
          inArray(apps.name, slugs),
          eq(apps.isSystemManaged, true),
          eq(apps.organizationId, orgData.organization.id),
        ),
      );

    const present = new Set(rows.map((r) => r.name));
    for (const probe of SERVICE_PROBES) {
      if (probe.logsApp && present.has(probe.logsApp)) {
        hrefs.set(probe.name, `/apps/${probe.logsApp}/logs`);
      }
    }
  } catch {
    // A missing logs link is not worth failing the health check over
  }

  return hrefs;
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
  const [services, resources, logsHrefs] = await Promise.all([
    Promise.all(
      SERVICE_PROBES.map(async (probe) => {
        if (probe.applies && !(await probe.applies())) return null;
        return runProbe(probe);
      }),
    ),
    getResourceStatuses(),
    resolveLogsHrefs(),
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
    services: services
      .filter((s): s is ServiceStatus => s !== null)
      .map((s) => ({ ...s, logsHref: logsHrefs.get(s.name) })),
    resources,
    runtime,
    auth,
  };
}
