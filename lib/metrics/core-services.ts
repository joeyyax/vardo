// Vardo's own containers grouped into plain-language services for the Metrics page.

import { dedupeByContainer } from "./aggregate";
import { formatBytes, formatCores } from "./format";
import type { GlossaryId } from "@/lib/ui/glossary";

/** The slice of a container row the shaping needs. */
export type CoreContainer = {
  containerId: string;
  containerName: string;
  composeService?: string | null;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  networkRx?: number;
  networkTx?: number;
};

export type CoreServiceKey =
  | "console"
  | "worker"
  | "database"
  | "cache"
  | "proxy"
  | "builder"
  | "watchdog"
  | "metrics"
  | "logs"
  | "mesh"
  | "other";

type CoreServiceDef = {
  label: string;
  term?: GlossaryId;
  /** Compose service or container names (minus the "vardo-" prefix) that belong to it. */
  names: string[];
};

/** Display order is the key order. */
export const CORE_SERVICE_DEFS: Record<CoreServiceKey, CoreServiceDef> = {
  console: { label: "Console", names: ["frontend", "console"] },
  worker: { label: "Worker", names: ["worker"] },
  database: { label: "Database (Postgres)", term: "core-postgres", names: ["postgres"] },
  cache: { label: "Cache (Redis)", term: "core-redis", names: ["redis"] },
  proxy: { label: "Proxy (Traefik)", term: "core-traefik", names: ["traefik"] },
  builder: { label: "Builder (BuildKit)", term: "core-buildkit", names: ["buildkit"] },
  watchdog: { label: "Watchdog", term: "core-watchdog", names: ["watchdog"] },
  metrics: { label: "Metrics (Collector)", term: "core-metrics", names: ["collector"] },
  logs: { label: "Logs (Loki/Promtail)", term: "core-logs", names: ["loki", "promtail"] },
  mesh: { label: "Mesh (WireGuard)", term: "mesh", names: ["wireguard", "mesh-builder"] },
  other: { label: "Other Vardo services", names: [] },
};

const KEY_ORDER = Object.keys(CORE_SERVICE_DEFS) as CoreServiceKey[];

/** Which core service a container belongs to. */
export function coreServiceKey(c: Pick<CoreContainer, "containerName" | "composeService">): CoreServiceKey {
  const name = (c.composeService || c.containerName)
    .toLowerCase()
    .replace(/^\//, "")
    .replace(/^vardo[-_]/, "")
    .replace(/[-_]\d+$/, "");
  for (const key of KEY_ORDER) {
    if (CORE_SERVICE_DEFS[key].names.includes(name)) return key;
  }
  return "other";
}

export type CoreServiceRow = {
  key: CoreServiceKey;
  label: string;
  term?: GlossaryId;
  /** Percent of one core, summed across the service's containers. */
  cpu: number;
  memory: number;
  /** Largest memory limit among its containers, 0 when none set. */
  limit: number;
  containers: number;
};

export type CoreTotals = { cpu: number; memory: number; containers: number };

export type CoreSummary = { rows: CoreServiceRow[]; totals: CoreTotals };

/** CPU, memory and count across containers, each counted once. */
export function containerTotals(containers: CoreContainer[]): CoreTotals {
  const unique = dedupeByContainer([containers]);
  return {
    cpu: unique.reduce((s, c) => s + c.cpuPercent, 0),
    memory: unique.reduce((s, c) => s + c.memoryUsage, 0),
    containers: unique.length,
  };
}

/** One row per core service that has containers, in display order, plus the combined total. */
export function shapeCoreServices(containers: CoreContainer[]): CoreSummary {
  const unique = dedupeByContainer([containers]);
  const byKey = new Map<CoreServiceKey, CoreServiceRow>();

  for (const c of unique) {
    const key = coreServiceKey(c);
    const row = byKey.get(key) ?? {
      key,
      label: CORE_SERVICE_DEFS[key].label,
      term: CORE_SERVICE_DEFS[key].term,
      cpu: 0,
      memory: 0,
      limit: 0,
      containers: 0,
    };
    row.cpu += c.cpuPercent;
    row.memory += c.memoryUsage;
    row.limit = Math.max(row.limit, c.memoryLimit);
    row.containers += 1;
    byKey.set(key, row);
  }

  return { rows: KEY_ORDER.flatMap((k) => byKey.get(k) ?? []), totals: containerTotals(unique) };
}

/** "Vardo uses 1.4 GB and 0.3 cores". */
export function describeCoreTotals(totals: Pick<CoreTotals, "cpu" | "memory">): string {
  return `Vardo uses ${formatBytes(totals.memory)} and ${formatCores(totals.cpu)}`;
}

/** True for apps in the Vardo system org. */
export function isCoreApp(app: { organizationId?: string | null }, coreOrgId: string | null): boolean {
  return coreOrgId !== null && app.organizationId === coreOrgId;
}

export type MetricsScope = { kind: "server" } | { kind: "org"; orgId: string };

/**
 * The scope a viewer gets for `?scope=`. "server" is admins only and their default;
 * an org id must be one the viewer belongs to. Anything else falls back to the default.
 */
export function resolveMetricsScope(input: {
  param: string | null | undefined;
  isAdmin: boolean;
  orgIds: string[];
  currentOrgId: string;
}): MetricsScope {
  const { param, isAdmin, orgIds, currentOrgId } = input;
  if (param === "server" && isAdmin) return { kind: "server" };
  if (param && param !== "server" && orgIds.includes(param)) return { kind: "org", orgId: param };
  return isAdmin ? { kind: "server" } : { kind: "org", orgId: currentOrgId };
}

/** Where a stat card's figure comes from: "on this server" or "in Acme". */
export function scopePhrase(scope: "server" | "org", orgName: string): string {
  return scope === "server" ? "on this server" : `in ${orgName}`;
}
