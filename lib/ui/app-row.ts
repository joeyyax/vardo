// ---------------------------------------------------------------------------
// Ledger row
//
// Fixed columns, tabular alignment, colour reserved for the abnormal. Ten
// healthy apps read as ten quiet lines so the crashed one is the only thing the
// eye lands on.
// ---------------------------------------------------------------------------

import { worstCondition, type AppCondition } from "@/lib/docker/conditions";

/** How loud a row is allowed to be. Only warning and critical earn a rail. */
export type RowSeverity = "none" | "info" | "warning" | "critical";

const SEVERITY_RANK: Record<RowSeverity, number> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

const STATUS_SEVERITY: Record<string, RowSeverity> = {
  error: "critical",
  missing: "warning",
  deploying: "info",
};

/** The worst thing true of a row: its status, its conditions, its pending config. */
export function rowSeverity(
  status: string,
  conditions?: AppCondition[] | null,
  needsRedeploy = false,
): RowSeverity {
  let severity: RowSeverity = STATUS_SEVERITY[status] ?? "none";
  const worst = worstCondition(conditions ?? []);
  if (worst) {
    const fromCondition: RowSeverity =
      worst.severity === "critical" ? "critical" : worst.severity === "warning" ? "warning" : "info";
    if (SEVERITY_RANK[fromCondition] > SEVERITY_RANK[severity]) severity = fromCondition;
  }
  if (needsRedeploy && SEVERITY_RANK.warning > SEVERITY_RANK[severity]) severity = "warning";
  return severity;
}

/** Left rail. Problem rows only — a healthy row carries no rail at all. */
export function railClass(severity: RowSeverity): string | null {
  if (severity === "critical") return "bg-status-error";
  if (severity === "warning") return "bg-status-warning";
  return null;
}

/** Trailing sparkline. Neutral until the state is abnormal, never by metric. */
export function sparklineTone(severity: RowSeverity): string {
  switch (severity) {
    case "critical":
      return "text-status-error";
    case "warning":
      return "text-status-warning";
    case "info":
      return "text-status-info";
    default:
      return "text-muted-foreground/40";
  }
}

const STATUS_WORD: Record<string, string> = {
  error: "crashed",
  missing: "no container",
  deploying: "deploying",
  stopped: "stopped",
};

/**
 * The word beside the name. Healthy rows drop it — the dot already says it —
 * and so does any row matching the status its header already states.
 */
export function statusWord(status: string, sharedStatus?: string | null): string | null {
  if (status === "active") return null;
  if (sharedStatus && status === sharedStatus) return null;
  return STATUS_WORD[status] ?? null;
}

export function statusWordTone(status: string): string {
  if (status === "error") return "text-status-error";
  if (status === "missing") return "text-status-warning";
  if (status === "deploying") return "text-status-info";
  return "text-muted-foreground";
}

/** Problems sort first. */
const STATUS_RANK: Record<string, number> = {
  error: 0,
  missing: 1,
  deploying: 2,
  stopped: 3,
  active: 4,
};

export function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 3;
}

/** One unit, so the column stays narrow: 12d, 4h, 37m, 8s. */
export function compactUptime(since: Date | string | number, now = Date.now()): string {
  const started = new Date(since).getTime();
  if (!Number.isFinite(started)) return "—";
  const ms = now - started;
  if (ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type SparkPath = { d: string; end: [number, number] };

/**
 * Trailing sparkline geometry. Min-max normalized so a steady series reads as a
 * centered flat line rather than pinning to an edge. Null below two points.
 */
export function sparkPath(values: number[], w = 64, h = 18, pad = 2): SparkPath | null {
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const range = Math.max(...points) - min;
  const round = (n: number) => Math.round(n * 100) / 100;

  const coords: [number, number][] = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const t = range > 0 ? (v - min) / range : 0.5;
    return [round(x), round(h - pad - t * (h - pad * 2))];
  });

  return {
    d: coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(""),
    end: coords[coords.length - 1],
  };
}

/** A reading that was never taken is n/a. Zero is a measurement, not an absence. */
export function readingLabel(
  value: number | null | undefined,
  format: (n: number) => string,
): string {
  return value === null || value === undefined ? "n/a" : format(value);
}

/** Plain lowercase, no chrome. Two fit the column; the rest become a count. */
export function tagLabels(names: string[], max = 2): { shown: string[]; overflow: number } {
  const clean = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  return { shown: clean.slice(0, max), overflow: Math.max(0, clean.length - max) };
}
