// ---------------------------------------------------------------------------
// Per-app stability
//
// Nothing here detects anything. The health monitor, the status reconciler and
// the deploy engine already decide what went wrong; this assembles their output
// into three answers: is the app stable now, has it been getting worse, and
// what happened the last time it was not.
//
// Durability matters to every number below. Docker's RestartCount is cumulative
// for one container and resets the moment that container is replaced, so it is
// reported with the point it resets from and never as a trend. The trend is
// computed only from rows that survive a deploy — activity events and
// deployment history.
//
// Not durable is not the same as not evidence. A live count is true of the
// container running now whatever a deploy later erases, so it withholds
// "Stable" without ever being counted as history — watch at most, never worse.
// ---------------------------------------------------------------------------

import type { AppCondition } from "@/lib/docker/conditions";
import { worstCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import { exitReasonShort } from "@/lib/ui/exit-reason";
import { formatRelativeTime, formatSpan, toDate, type DateInput } from "@/lib/ui/relative-time";

/** Window each half of the trend comparison covers. */
export const TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A fault this recent still colors an app that is running again. */
export const RECENT_FAULT_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type IncidentKind =
  | "crashed"
  | "crash-looping"
  | "recovered"
  | "self-healed"
  | "deploy-failed"
  | "rolled-back"
  | "deploy-incomplete";

export type Incident = {
  kind: IncidentKind;
  /** Epoch ms, so ordering and windowing never parse twice. */
  at: number;
  detail: string;
};

/**
 * A recovery closes an incident and a self-heal answers one; counting either
 * would double the fault it followed. Everything else counts.
 */
const NON_FAULTS = new Set<IncidentKind>(["recovered", "self-healed"]);

export function isFault(kind: IncidentKind): boolean {
  return !NON_FAULTS.has(kind);
}

const INCIDENT_LABELS: Record<IncidentKind, string> = {
  crashed: "Crashed",
  "crash-looping": "Crash loop",
  recovered: "Recovered",
  "self-healed": "Self-healed",
  "deploy-failed": "Deploy failed",
  "rolled-back": "Rolled back",
  "deploy-incomplete": "Deploy incomplete",
};

export function incidentLabel(kind: IncidentKind): string {
  return INCIDENT_LABELS[kind];
}

/**
 * A recovery is good news and every fault reads in the error hue. A self-heal
 * is neither — it is what Vardo did between the two, so it stays unpainted.
 */
export function incidentTone(kind: IncidentKind): string {
  if (kind === "self-healed") return "text-muted-foreground";
  return kind === "recovered" ? "text-status-success" : "text-status-error";
}

/** Activity rows the stability timeline is built from. */
export const STABILITY_ACTIONS = [
  "app.crashed",
  "app.crash_looping",
  "app.recovered",
  "app.self_healed",
] as const;

export type StabilityActivityRow = {
  action: string;
  createdAt: DateInput;
  metadata: unknown;
};

export type StabilityDeployment = {
  status: string;
  postDeployError: string | null;
  startedAt: DateInput;
  finishedAt: DateInput;
};

function read(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function fromActivity(row: StabilityActivityRow): Incident | null {
  const date = toDate(row.createdAt);
  if (!date) return null;
  const at = date.getTime();
  const summary = read(row.metadata, "summary");

  switch (row.action) {
    case "app.crashed":
      return { kind: "crashed", at, detail: summary ?? "Container stopped without being asked to" };
    case "app.crash_looping":
      return { kind: "crash-looping", at, detail: summary ?? "Restarting without ever reaching healthy" };
    case "app.recovered":
      return { kind: "recovered", at, detail: summary ?? "Running again" };
    case "app.self_healed":
      return { kind: "self-healed", at, detail: summary ?? "Vardo restarted an unhealthy container" };
    default:
      return null;
  }
}

function fromDeployment(d: StabilityDeployment): Incident | null {
  const date = toDate(d.finishedAt) ?? toDate(d.startedAt);
  if (!date) return null;
  const at = date.getTime();

  if (d.status === "failed") return { kind: "deploy-failed", at, detail: "The deploy did not finish" };
  if (d.status === "rolled_back") {
    return { kind: "rolled-back", at, detail: "The release crashed and the previous one was restored" };
  }
  if (d.status === "success" && d.postDeployError) {
    return { kind: "deploy-incomplete", at, detail: d.postDeployError.split("\n")[0].trim() };
  }
  return null;
}

/**
 * One timeline from both durable sources, newest first. Activity rows carry
 * container faults; deployment rows carry the release ones.
 */
export function buildIncidents(
  activity: StabilityActivityRow[],
  deployments: StabilityDeployment[],
): Incident[] {
  const incidents = [
    ...activity.map(fromActivity),
    ...deployments.map(fromDeployment),
  ].filter((i): i is Incident => i !== null);

  return incidents.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Restart count
// ---------------------------------------------------------------------------

export type RestartReading = {
  /** Docker RestartCount summed across the app's containers. */
  count: number;
  /** Creation time of the oldest of those containers — where the count restarts from. */
  since: string | null;
};

/** Restarts one container absorbs without meaning anything: a host reboot, a daemon upgrade. */
export const RESTART_ORDINARY = 2;

/** Whether the live count is high enough to withhold a clean verdict. */
export function restartsElevated(reading: RestartReading | null): reading is RestartReading {
  return reading !== null && reading.count > RESTART_ORDINARY;
}

/** The restart figure's hue. Ordinary counts stay in the body colour. */
export function restartTone(reading: RestartReading | null): string {
  return restartsElevated(reading) ? "text-status-warning" : "text-foreground";
}

/** Shape a ledger row's condition column takes. Matches AppRow's `note` prop. */
export type RestartCue = { label: string; tone: string; title: string };

/** Row-width cue for a container that has been restarting, or null when it has not. */
export function restartCue(reading: RestartReading | null): RestartCue | null {
  if (!restartsElevated(reading)) return null;
  return {
    label: plural(reading.count, "restart"),
    tone: "text-status-warning",
    title: "Docker's counter for the container running now. Replacing the container resets it to zero.",
  };
}

/**
 * The restart figure and the sentence that stops it being read as history.
 * Docker zeroes RestartCount on a new container, so every deploy erases it.
 */
export function restartCaption(reading: RestartReading | null, now: number): string {
  if (!reading) return "Docker was not reachable";
  const since = toDate(reading.since);
  if (!since) return "Since the container was created. A deploy replaces it and the count restarts at zero";
  return `Since this container was created ${containerAge(since, now)}. A deploy replaces it and the count restarts at zero`;
}

/** Days, so the Created date beside it can be checked against this. */
function containerAge(since: Date, now: number): string {
  const days = Math.floor((now - since.getTime()) / 86_400_000);
  return days < 1 ? formatRelativeTime(since, new Date(now)) : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/** "unknown" is what a window with no durable history behind it earns. */
export type TrendDirection = "quiet" | "improving" | "steady" | "worsening" | "unknown";

export type StabilityTrend = {
  direction: TrendDirection;
  /** Faults inside the most recent window. */
  recent: number;
  /** Faults inside the window before it, undefined when it is not covered. */
  prior: number | undefined;
  label: string;
};

/**
 * Faults in the last window against the one before it. `historyFrom` is the
 * earliest point durable history exists for — with the prior window only
 * partly covered there is nothing to compare against, and saying "improving"
 * would only mean the app is young.
 */
export function stabilityTrend(
  incidents: Incident[],
  now: number,
  historyFrom: DateInput,
  windowMs: number = TREND_WINDOW_MS,
): StabilityTrend {
  const faults = incidents.filter((i) => isFault(i.kind));
  const recent = faults.filter((i) => i.at > now - windowMs).length;

  const start = toDate(historyFrom);
  const covered = start !== null && start.getTime() <= now - 2 * windowMs;
  if (!covered) {
    return {
      direction: "unknown",
      recent,
      prior: undefined,
      label: recent === 0 ? "Not enough history to compare" : `${plural(recent, "incident")}, no earlier period to compare`,
    };
  }

  const prior = faults.filter((i) => i.at > now - 2 * windowMs && i.at <= now - windowMs).length;

  if (recent === 0 && prior === 0) {
    return { direction: "quiet", recent, prior, label: "No incidents either period" };
  }
  if (recent > prior) {
    return { direction: "worsening", recent, prior, label: `${plural(recent, "incident")}, up from ${prior}` };
  }
  if (recent < prior) {
    return { direction: "improving", recent, prior, label: `${plural(recent, "incident")}, down from ${prior}` };
  }
  return { direction: "steady", recent, prior, label: `${plural(recent, "incident")}, same as the period before` };
}

/** Header-width form of the trend, or null when there is nothing to add. */
export function trendBadge(trend: StabilityTrend, windowMs: number = TREND_WINDOW_MS): string | null {
  if (trend.recent === 0) return null;
  const days = Math.round(windowMs / 86_400_000);
  return `${trend.recent} in ${days}d${trend.direction === "worsening" ? ", up" : ""}`;
}

/**
 * What qualifies the verdict in the width a header stat has. Durable incidents
 * win; the live restart count speaks only when they have nothing to say.
 */
export function stabilityCue(
  trend: StabilityTrend,
  restarts: RestartReading | null,
  windowMs: number = TREND_WINDOW_MS,
): string | null {
  const badge = trendBadge(trend, windowMs);
  if (badge) return badge;
  return restartsElevated(restarts) ? plural(restarts.count, "restart") : null;
}

/** Worsening is the only direction that carries a state hue. */
export function trendTone(direction: TrendDirection): string {
  if (direction === "worsening") return "text-status-warning";
  if (direction === "improving") return "text-status-success";
  return "text-muted-foreground";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type StabilityLevel = "stable" | "watch" | "unstable" | "down" | "unknown";

export type StabilityVerdict = {
  level: StabilityLevel;
  /** The answer to "is this app stable right now", in one or two words. */
  headline: string;
  /** What makes it that, or null when nothing qualifies the headline. */
  detail: string | null;
};

export type VerdictInput = {
  now: number;
  status: string;
  conditions: AppCondition[] | null;
  exitReason: ExitReason | null;
  /** Newest first, as buildIncidents returns them. */
  incidents: Incident[];
  trend: StabilityTrend;
  /** Docker's live counter, or null when it could not be read. */
  restarts: RestartReading | null;
};

/** Conditions that mean the app is failing even while Docker calls it running. */
const UNSTABLE_KINDS = new Set<AppCondition["kind"]>(["crash-looping", "self-heal-exhausted"]);

export function stabilityVerdict(input: VerdictInput): StabilityVerdict {
  const conditions = input.conditions ?? [];
  const unstable = conditions.find((c) => UNSTABLE_KINDS.has(c.kind));
  const lastFault = input.incidents.find((i) => isFault(i.kind));

  if (input.status === "deploying") {
    return { level: "unknown", headline: "Deploying", detail: "Ask again when the deploy settles" };
  }
  if (unstable) {
    return { level: "unstable", headline: "Unstable", detail: unstable.detail };
  }
  if (input.status === "error") {
    return {
      level: "down",
      headline: "Down",
      detail: input.exitReason ? `Last container ${exitReasonShort(input.exitReason)}` : "Not running",
    };
  }
  if (input.status === "missing") {
    return { level: "down", headline: "No container", detail: "Nothing is running for this app" };
  }
  if (input.status === "stopped") {
    return { level: "unknown", headline: "Stopped", detail: "Stability is not measurable while it is off" };
  }

  const worst = worstCondition(conditions);
  if (worst) {
    return { level: "watch", headline: "Degraded", detail: worst.detail };
  }

  if (lastFault && input.now - lastFault.at < RECENT_FAULT_MS) {
    return {
      level: "watch",
      headline: "Running again",
      detail: `${incidentLabel(lastFault.kind).toLowerCase()} ${formatRelativeTime(lastFault.at, new Date(input.now))}`,
    };
  }
  const restarting = restartsElevated(input.restarts) ? input.restarts : null;

  if (input.trend.recent > 0) {
    return {
      level: "watch",
      headline: "Running",
      detail: restarting
        ? `${input.trend.label}, ${plural(restarting.count, "restart")} on this container`
        : `${input.trend.label} — clean right now`,
    };
  }
  // Nothing durable to go on, but the container running now has been restarting.
  // Enough to withhold "Stable", never enough to claim more than watch.
  if (restarting) {
    return {
      level: "watch",
      headline: "Running",
      detail: `${plural(restarting.count, "restart")} on the container running now, none recorded as incidents`,
    };
  }

  // The stats below carry the last incident date; repeating it here says nothing.
  return { level: "stable", headline: "Stable", detail: null };
}

const LEVEL_TONE: Record<StabilityLevel, string> = {
  stable: "text-status-success",
  watch: "text-status-warning",
  unstable: "text-status-error",
  down: "text-status-error",
  unknown: "text-status-neutral",
};

export function stabilityTone(level: StabilityLevel): string {
  return LEVEL_TONE[level];
}

/** Muted tint for the verdict band, matched to stabilityTone. */
const LEVEL_SURFACE: Record<StabilityLevel, string> = {
  stable: "border-status-success/40 bg-status-success-muted/40",
  watch: "border-status-warning/40 bg-status-warning-muted/40",
  unstable: "border-status-error/40 bg-status-error-muted/40",
  down: "border-status-error/40 bg-status-error-muted/40",
  unknown: "border-border bg-muted/40",
};

export function stabilitySurface(level: StabilityLevel): string {
  return LEVEL_SURFACE[level];
}

// ---------------------------------------------------------------------------
// State duration
// ---------------------------------------------------------------------------

/**
 * How long the app has held its current status. Null on a row that has not
 * transitioned since the stamp landed — no duration beats a wrong one.
 */
export function heldFor(statusChangedAt: DateInput, now: number): string | null {
  const since = toDate(statusChangedAt);
  if (!since) return null;
  const ms = now - since.getTime();
  if (ms < 10_000) return null;
  return formatSpan(since, new Date(now));
}
