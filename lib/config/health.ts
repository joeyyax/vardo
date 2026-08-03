import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import nextPkg from "next/package.json";
import { getAuthMethodStates } from "@/lib/config/auth-methods";
import { CORE_SERVICE_FEATURES } from "@/lib/infra/core-services";
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
    // IPv6, including the `::1:7300` a dual-stack connect failure reports.
    .replace(/(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}(?::\d+)?/gi, "[host]")
    .replace(/\blocalhost(?::\d+)?\b/gi, "[host]")
    .replace(/\b(role|database|user) "[^"]+"/gi, "$1 [name]")
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * The reason behind a wrapper error, or "" when there isn't one worth printing.
 *
 * `fetch` reports "fetch failed" and hangs the reason off the cause. On a
 * dual-stack host that cause is an AggregateError whose own message is empty —
 * the ECONNREFUSED sits one level further down, in `errors`.
 */
function errorReason(err: Error): string {
  if (err.message) return err.message;
  const inner = (err as AggregateError).errors;
  if (Array.isArray(inner)) {
    for (const e of inner) {
      if (e instanceof Error) {
        const reason = errorReason(e);
        if (reason) return reason;
      }
    }
  }
  return "";
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause instanceof Error) {
    const reason = errorReason(err.cause);
    if (reason) return `${err.message}: ${reason}`;
  }
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

/** Feature flag behind each core service, keyed by app name. */
const CORE_SERVICE_FLAG_BY_APP = new Map(
  CORE_SERVICE_FEATURES.flatMap((f) => f.services.map((s) => [s.name, f.flag] as const)),
);

/**
 * A probe for an instance-level core service. Gated on the flag that provisions
 * it, so a service the operator never installed reads as absent, not broken.
 */
function coreServiceProbe(app: string, probe: Omit<Probe, "logsApp" | "applies">): Probe {
  const flag = CORE_SERVICE_FLAG_BY_APP.get(app);
  if (!flag) throw new Error(`No core service feature flag for "${app}"`);
  return {
    ...probe,
    logsApp: app,
    applies: async () => {
      const { isFeatureEnabledAsync } = await import("@/lib/config/features");
      return isFeatureEnabledAsync(flag);
    },
  };
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
  coreServiceProbe("cadvisor", {
    name: "cAdvisor",
    description: "Container metrics",
    timeoutMs: 2000,
    run: (timeoutMs) =>
      httpProbe(`${process.env.CADVISOR_URL || "http://localhost:7300"}/healthz`, timeoutMs),
  }),
  coreServiceProbe("loki", {
    name: "Loki",
    description: "Log aggregation",
    timeoutMs: 2000,
    run: (timeoutMs) =>
      httpProbe(`${process.env.LOKI_URL || "http://localhost:7400"}/ready`, timeoutMs),
  }),
  coreServiceProbe("promtail", {
    name: "Promtail",
    description: "Log shipper",
    timeoutMs: 5000,
    // Promtail's HTTP server never joins vardo-network, so there is nothing to
    // call. A running container is the only signal reachable from here.
    run: async () => {
      const { listContainers } = await import("@/lib/docker/client");
      const running = await listContainers("promtail");
      if (running.length === 0) throw new Error("not running");
    },
  }),
  coreServiceProbe("glitchtip", {
    name: "GlitchTip",
    description: "Error tracking",
    timeoutMs: 2000,
    // The error-tracking client's own probe, so the dot and the Errors tab
    // agree. GLITCHTIP_URL applies only when nothing is configured.
    run: async (timeoutMs) => {
      const { probeGlitchTip } = await import("@/lib/error-tracking/client");
      await probeGlitchTip(timeoutMs);
    },
  }),
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

/** Whether a probe runs. An unreadable flag still probes — unknown is not absent. */
async function probeApplies(probe: Probe): Promise<boolean> {
  if (!probe.applies) return true;
  return probe.applies().catch(() => true);
}

/**
 * Re-probe a single service by name. Returns null when the name is unknown or
 * the service does not apply to this instance.
 */
export async function checkServiceByName(name: string): Promise<ServiceStatus | null> {
  const probe = SERVICE_PROBES.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!probe) return null;
  if (!(await probeApplies(probe))) return null;

  const [status, logsHrefs] = await Promise.all([runProbe(probe), resolveLogsHrefs()]);
  return { ...status, logsHref: logsHrefs.get(probe.name) };
}

/**
 * Logs pages for services Vardo runs as system-managed apps. These are
 * instance-level singletons living in the Vardo system org, so the lookup spans
 * every org and app-admin is the gate rather than the viewer's active org.
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

    const { isAppAdmin } = await import("@/lib/auth/admin");
    if (!(await isAppAdmin())) return hrefs;

    // Core service names are unique instance-wide, so no org filter — scoping
    // to the viewer's active org hid the link from every admin but one.
    const { apps } = await import("@/lib/db/schema");
    const { and, eq, inArray } = await import("drizzle-orm");
    const rows = await db
      .select({ name: apps.name })
      .from(apps)
      .where(and(inArray(apps.name, slugs), eq(apps.isSystemManaged, true)));

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
    const { getFleetTotals } = await import("@/lib/metrics/fleet-totals");

    // Both cards need a real sample. Without one they are omitted rather than
    // rendered at zero — an idle fleet and an unmeasured one look identical.
    const [systemInfo, totals] = await Promise.all([
      getSystemInfo().catch(() => null),
      getFleetTotals().catch(() => null),
    ]);

    if (systemInfo && totals) {
      const maxCpu = systemInfo.cpus * 100;
      const cpuPercent = maxCpu > 0 ? (totals.cpuPercent / maxCpu) * 100 : 0;
      resources.push({
        name: "CPU",
        current: Math.round(totals.cpuPercent * 100) / 100,
        total: maxCpu,
        percent: Math.round(cpuPercent * 10) / 10,
        unit: "%",
        status: resourceStatus(cpuPercent, THRESHOLDS.cpu),
      });

      const memPercent = systemInfo.memoryTotal > 0
        ? (totals.memoryBytes / systemInfo.memoryTotal) * 100
        : 0;
      resources.push({
        name: "Memory",
        current: totals.memoryBytes,
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
        if (!(await probeApplies(probe))) return null;
        return runProbe(probe);
      }),
    ),
    getResourceStatuses(),
    resolveLogsHrefs(),
  ]);

  const methods = await getAuthMethodStates();
  const auth: AuthConfig = {
    passkeys: methods.passkey,
    magicLink: methods["magic-link"],
    github: methods.github,
    passwords: methods.password,
    twoFactor: methods.totp,
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
