// ---------------------------------------------------------------------------
// Ledger row
//
// Fixed columns, tabular alignment, colour reserved for the abnormal. Ten
// healthy apps read as ten quiet lines so the crashed one is the only thing the
// eye lands on.
// ---------------------------------------------------------------------------

import { worstCondition, type AppCondition } from "@/lib/docker/conditions";
import { conditionLabel, conditionTone } from "@/lib/ui/conditions";
import { restartCue } from "@/lib/ui/stability";

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

// ---------------------------------------------------------------------------
// The note beside the name
// ---------------------------------------------------------------------------

/** The one thing worth saying about a row beyond its status. */
export type RowNote = { label: string; tone: string; detail?: string };

/**
 * Worst condition first, then pending config, then whatever the caller offers.
 * The row and its hover card read this so the two never disagree.
 */
export function rowNote(
  conditions?: AppCondition[] | null,
  needsRedeploy?: boolean | null,
  fallback?: RowNote | null,
): RowNote | null {
  const worst = worstCondition(conditions ?? []);
  if (worst) {
    return { label: conditionLabel(worst), tone: conditionTone(worst.severity), detail: worst.detail };
  }
  // Restart cannot clear this. `compose restart` reuses the containers, so env,
  // labels and compose changes only land when a deploy recreates them.
  if (needsRedeploy) {
    return {
      label: "deploy needed",
      tone: "text-status-warning",
      detail: "Config changed since the last deploy",
    };
  }
  return fallback ?? null;
}

/**
 * The restart cue as a note, or null when the count is unread or ordinary. A
 * row carries the count alone; the anchor it resets from is a detail-page fact.
 */
export function restartNote(count: number | null | undefined): RowNote | null {
  if (count === null || count === undefined) return null;
  const cue = restartCue({ count, since: null });
  return cue && { label: cue.label, tone: cue.tone, detail: cue.title };
}

// ---------------------------------------------------------------------------
// Middle columns
// ---------------------------------------------------------------------------

/**
 * What the row runs: the image without its registry host, or the git repo.
 * Also what tells a compose parent apart from the child that shares its name.
 */
export function sourceRef(app: {
  imageName?: string | null;
  gitUrl?: string | null;
}): string | null {
  const image = app.imageName?.trim();
  if (image) {
    const parts = image.split("/");
    // A first segment carrying a dot or a port is a registry host, not a namespace.
    if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
    return parts.join("/") || null;
  }
  const git = app.gitUrl?.trim();
  if (!git) return null;
  return (
    git
      .replace(/^git@[^:]+:/, "")
      .replace(/^[a-z+]+:\/\/[^/]+\//i, "")
      .replace(/\.git$/, "") || null
  );
}

/** Where the row answers. The primary domain, else the first one it has. */
export function primaryDomain(
  domains?: { domain: string; isPrimary?: boolean | null }[] | null,
): string | null {
  if (!domains || domains.length === 0) return null;
  return (domains.find((d) => d.isPrimary) ?? domains[0]).domain ?? null;
}

// ---------------------------------------------------------------------------
// Truncation order
//
// A row that runs out of width must destroy its columns in order of least
// worth, and the name is worth the most. CSS decides that by flex-shrink x
// flex-basis, which is why `flex-1` (basis 0) on a neighbour is a trap: it
// weighs nothing, absorbs no shrinkage, and leaves the name to take all of it.
// ---------------------------------------------------------------------------

/** Cell classes, shared with the component so the order below is the real one. */
export const ROW_NAME_CELL = "min-w-0 shrink truncate";
export const ROW_NOTE_CELL = "min-w-0 shrink-[9999] truncate";
export const ROW_SOURCE_CELL = "min-w-0 w-44 shrink-[9999] truncate hidden @[40rem]:block";
export const ROW_DOMAIN_CELL = "min-w-0 w-52 shrink-[9999] truncate hidden @[52rem]:block";
export const ROW_TAGS_CELL = "hidden max-w-32 truncate text-muted-foreground/60 @[34rem]:inline";
export const ROW_UPTIME_CELL = "w-9 shrink-0 text-right tabular-nums";
export const ROW_SPARKLINE_CELL =
  "hidden h-[18px] w-16 shrink-0 items-center justify-end @[26rem]:flex";
export const ROW_ICONS_CELL = "flex shrink-0 items-center justify-end gap-1.5 @[26rem]:w-14";
/**
 * Holds the fixed columns. No min-w-0: min-content is the width of its own
 * shrink-0 children, so it squeezes the middle columns flat, freezes there, and
 * only then does the name start losing characters.
 */
export const ROW_TRAILING_CELL = "ml-auto flex shrink-[9999] items-center gap-2.5";

// ---------------------------------------------------------------------------
// Column gates
//
// The container is the ledger card, not the viewport, and the page caps it: a
// 1280px shell less 80px of gutter, a 192px rail, a 32px gap and 12px of card
// padding leave 964px however wide the display is. A gate above that never opens.
// ---------------------------------------------------------------------------

/** Widest the card's content box ever gets, in px. */
export const LEDGER_CARD_MAX_PX = 964;

/** The @[…rem] width a cell waits for, in px. Null when it never hides. */
export function containerGatePx(className: string, rootFontSize = 16): number | null {
  let smallest: number | null = null;
  for (const name of className.split(/\s+/)) {
    const match = /^@\[(\d+(?:\.\d+)?)rem\]:/.exec(name);
    if (!match) continue;
    const px = Number(match[1]) * rootFontSize;
    if (smallest === null || px < smallest) smallest = px;
  }
  return smallest;
}

const SPACING_PX = 4;

/** flex-shrink x flex-basis, the factor CSS shares shrinkage out by. */
export function shrinkWeight(className: string, contentWidth = 100): number {
  let shrink = 1;
  let basis: number | null = null;
  for (const name of className.split(/\s+/)) {
    if (name === "shrink-0" || name === "flex-none") shrink = 0;
    else if (name === "shrink") shrink = 1;
    else if (name.startsWith("shrink-[")) shrink = Number(name.slice(8, -1)) || 0;
    else if (name === "flex-1" || name === "basis-0") basis = 0;
    else if (name === "flex-auto" || name === "basis-auto") basis = null;
    else if (/^w-\d+(\.\d+)?$/.test(name)) basis = Number(name.slice(2)) * SPACING_PX;
  }
  return shrink * (basis ?? contentWidth);
}

export type RowCell = { id: string; className: string; width?: number };

/** Which cells give up width first. Heaviest first; the last one truncates last. */
export function truncationOrder(cells: RowCell[]): string[] {
  return cells
    .map((cell, index) => ({ ...cell, index, weight: shrinkWeight(cell.className, cell.width) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((cell) => cell.id);
}
