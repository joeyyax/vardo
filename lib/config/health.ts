import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import nextPkg from "next/package.json";
import { getAuthMethodStates } from "@/lib/config/auth-methods";
import { CORE_SERVICE_FEATURES } from "@/lib/infra/core-services";
import { cpuDisplay, formatBytes, formatDuration, sharePercent } from "@/lib/metrics/format";

export type ServiceStatus = {
  name: string;
  description: string;
  status: "healthy" | "unhealthy" | "unconfigured";
  latencyMs?: number;
  error?: string;
  /** ISO timestamp of the probe that produced this status. */
  checkedAt: string;
  /** Probe timeout. */
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
  /** Rendered share. */
  headline: string;
  /** Line under the bar, in the ceiling's unit. */
  detail: string;
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

const THRESHOLDS = {
  cpu: { warning: 80, critical: 95 },
  memory: { warning: 80, critical: 95 },
  disk: { warning: 80, critical: 90 },
};

const MAX_ERROR_LENGTH = 120;

/** Strip connection strings, hosts and pg role/database/user names from an error message. */
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

/** Reason behind a wrapper error, or "". Dual-stack fetch failures nest it in AggregateError.errors. */
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

/** Operator-facing text for a failed probe; timeouts say so. */
export function probeErrorText(err: unknown, timeoutMs: number): string {
  return isTimeout(err)
    ? `Timed out after ${formatDuration(timeoutMs, { precise: true })}`
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

/** Probe for a core service, gated on the feature flag that provisions it. */
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
    // Promtail serves nothing the console reads; a running container is the only signal.
    run: async () => {
      const { listContainers } = await import("@/lib/docker/client");
      const running = await listContainers("promtail");
      if (running.length === 0) throw new Error("not running");
    },
  }),
  {
    name: "Traefik",
    description: "Reverse proxy and SSL",
    timeoutMs: 2000,
    // Overridable: localhost is the frontend container itself, not the proxy. /ping needs no credentials.
    run: (timeoutMs) =>
      httpProbe(`${process.env.TRAEFIK_URL || "http://localhost:8080"}/ping`, timeoutMs),
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

/** Whether a probe runs. An unreadable flag still probes. */
async function probeApplies(probe: Probe): Promise<boolean> {
  if (!probe.applies) return true;
  return probe.applies().catch(() => true);
}

/** Re-probe one service by name. Null when unknown or not applicable. */
export async function checkServiceByName(name: string): Promise<ServiceStatus | null> {
  const probe = SERVICE_PROBES.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!probe) return null;
  if (!(await probeApplies(probe))) return null;

  const [status, logsHrefs] = await Promise.all([runProbe(probe), resolveLogsHrefs()]);
  return { ...status, logsHref: logsHrefs.get(probe.name) };
}

/** Logs pages for system-managed core services. Spans every org; gated on app admin. */
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

    // No org filter: core services live in the system org.
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
    // Non-fatal.
  }

  return hrefs;
}

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

    // Omit both cards without a real sample; zero would look like an idle fleet.
    const [systemInfo, totals] = await Promise.all([
      getSystemInfo().catch(() => null),
      getFleetTotals().catch(() => null),
    ]);

    if (systemInfo && totals) {
      // In cores, matching /metrics.
      const cpu = cpuDisplay(totals.cpuPercent, { kind: "capacity", cores: systemInfo.cpus });
      const cpuPercent = cpu.share ?? 0;
      resources.push({
        name: "CPU",
        current: cpu.cores ?? 0,
        total: systemInfo.cpus,
        percent: Math.round(cpuPercent * 10) / 10,
        unit: "cores",
        headline: cpu.headline,
        detail: cpu.detail ?? cpu.headline,
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
        headline: sharePercent(memPercent),
        detail: `${formatBytes(totals.memoryBytes)} / ${formatBytes(systemInfo.memoryTotal)}`,
        status: resourceStatus(memPercent, THRESHOLDS.memory),
      });
    }

    // df, not docker system df (3s+).
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
            headline: sharePercent(diskPercent),
            detail: `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`,
            status: resourceStatus(diskPercent, THRESHOLDS.disk),
          });
        }
      }
    } catch {
      // df not available
    }
  } catch {
    // Best-effort.
  }

  return resources;
}

/** Health of infrastructure services, resource usage and auth config. */

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
