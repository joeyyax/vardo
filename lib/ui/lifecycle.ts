// ---------------------------------------------------------------------------
// App lifecycle events
//
// The Deployments tab answers "what has been done to this app". A deploy is
// most of that answer; a restart, a stop and a start are the rest, and they
// left no record anywhere before this.
//
// Only operator actions land here. Docker's restart policy and Vardo's own
// self-heal restart are things that happened to the app, not things done to
// it — they belong to Stability, which reads them from their own sources.
// ---------------------------------------------------------------------------

import { toDate, type DateInput } from "@/lib/ui/relative-time";

/** Activity actions the Deployments timeline is built from. */
export const LIFECYCLE_ACTIONS = ["app.restarted", "app.stopped", "app.started"] as const;

export type LifecycleKind = "restarted" | "stopped" | "started";

/** What one click acted on: the app, one compose service, or a whole stack. */
export type LifecycleScope = "app" | "service" | "stack";

/** How the action reached Vardo. The UI is the unmarked case. */
export type LifecycleTrigger = "api" | "mcp";

/** What Docker reported once the command returned. Mirrors ObservedStatus. */
export type LifecycleStatus = "active" | "error" | "stopped" | "missing";

/** Something worth saying about how the action ended. Matches AppRow's `note` shape. */
export type LifecycleNote = { label: string; tone: string; title?: string };

export type LifecycleRow = {
  id: string;
  action: string;
  createdAt: DateInput;
  metadata: unknown;
  user: { name: string | null; email: string } | null;
};

export type LifecycleEvent = {
  id: string;
  kind: LifecycleKind;
  /** Epoch ms, so ordering never parses twice. */
  at: number;
  /** What was done, in one phrase. */
  label: string;
  /** Who did it and how, or null when neither is known. */
  detail: string | null;
  /** How long the command took, or null on a row that recorded no span. */
  durationMs: number | null;
  /** How it ended, worst first. Empty when there is nothing to add. */
  notes: LifecycleNote[];
};

const KIND_BY_ACTION: Record<string, LifecycleKind> = {
  "app.restarted": "restarted",
  "app.stopped": "stopped",
  "app.started": "started",
};

const VERBS: Record<LifecycleKind, string> = {
  restarted: "Restarted",
  stopped: "Stopped",
  started: "Started",
};

const TRIGGER_LABELS: Record<string, string> = { api: "API", mcp: "MCP" };

/** What each action leaves the app as when it worked. */
const INTENDED: Record<LifecycleKind, LifecycleStatus> = {
  restarted: "active",
  started: "active",
  stopped: "stopped",
};

const STATUS_LABELS: Record<LifecycleStatus, string> = {
  active: "now running",
  error: "now crashed",
  stopped: "now stopped",
  missing: "no container",
};

const STATUS_TONES: Record<LifecycleStatus, string> = {
  active: "text-status-warning",
  error: "text-status-error",
  stopped: "text-status-warning",
  missing: "text-status-error",
};

function field(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function read(metadata: unknown, key: string): string | undefined {
  const value = field(metadata, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A span in milliseconds, or undefined for anything that is not one. */
function readMs(metadata: unknown, key: string): number | undefined {
  const value = field(metadata, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const STATUSES = new Set<string>(Object.keys(STATUS_LABELS));

function readStatus(metadata: unknown): LifecycleStatus | undefined {
  const value = read(metadata, "status");
  return value && STATUSES.has(value) ? (value as LifecycleStatus) : undefined;
}

/** What the phrase names: the app itself, one service inside a stack, or the stack. */
export function lifecycleLabel(
  kind: LifecycleKind,
  scope: LifecycleScope,
  service?: string | null,
): string {
  const verb = VERBS[kind];
  if (scope === "service" && service) return `${verb} the ${service} service`;
  if (scope === "stack") return `${verb} the stack`;
  return verb;
}

/**
 * "by Joey", "by Joey via API", "by Vardo". Naming the actor is what makes the
 * line worth reading — a restart someone chose is not the same event as one
 * Vardo ran on its own.
 */
export function lifecycleDetail(
  actor: { name: string | null; email: string } | null,
  trigger?: string | null,
): string | null {
  const who = actor ? actor.name?.trim() || actor.email : "Vardo";
  const how = trigger ? TRIGGER_LABELS[trigger] ?? trigger : null;
  return how ? `by ${who} via ${how}` : `by ${who}`;
}

/**
 * How the action ended, worst first. A status the action did not intend is the
 * point of the row — a restart that came back crashed must not read like one
 * that came back healthy.
 *
 * Empty for a row that recorded no status: absent is not success. Every row
 * written before this was recorded is one of those.
 */
export function lifecycleNotes(
  kind: LifecycleKind,
  status?: LifecycleStatus | null,
  needsRedeploy?: boolean,
): LifecycleNote[] {
  const notes: LifecycleNote[] = [];
  if (status && status !== INTENDED[kind]) {
    notes.push({ label: STATUS_LABELS[status], tone: STATUS_TONES[status] });
  }
  if (needsRedeploy) {
    notes.push({
      label: "config still pending",
      tone: "text-status-warning",
      title: "Env, Traefik labels and compose changes only apply on a deploy.",
    });
  }
  return notes;
}

/** Rendered events for the timeline, newest first. Unknown actions are dropped. */
export function buildLifecycleEvents(rows: LifecycleRow[]): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];

  for (const row of rows) {
    const kind = KIND_BY_ACTION[row.action];
    const date = toDate(row.createdAt);
    if (!kind || !date) continue;

    const scope = (read(row.metadata, "scope") ?? "app") as LifecycleScope;
    events.push({
      id: row.id,
      kind,
      at: date.getTime(),
      label: lifecycleLabel(kind, scope, read(row.metadata, "service")),
      detail: lifecycleDetail(row.user, read(row.metadata, "trigger")),
      durationMs: readMs(row.metadata, "durationMs") ?? null,
      notes: lifecycleNotes(
        kind,
        readStatus(row.metadata),
        field(row.metadata, "needsRedeploy") === true,
      ),
    });
  }

  return events.sort((a, b) => b.at - a.at);
}

/**
 * Events split by the release currently serving. Those after it happened to
 * the live deploy and read above it; the rest belong in history alongside the
 * deploys they sit between.
 */
export function partitionLifecycle(
  events: LifecycleEvent[],
  liveAt: DateInput,
): { since: LifecycleEvent[]; earlier: LifecycleEvent[] } {
  const live = toDate(liveAt);
  if (!live) return { since: [], earlier: events };
  const cutoff = live.getTime();
  return {
    since: events.filter((e) => e.at >= cutoff),
    earlier: events.filter((e) => e.at < cutoff),
  };
}

export type TimelineItem<T> =
  | { kind: "deploy"; deploy: T }
  | { kind: "lifecycle"; event: LifecycleEvent };

/**
 * Deploy cards and the lifecycle lines between them, newest first. A deploy
 * wins a tie so a restart never renders above the deploy that caused it.
 */
export function interleaveHistory<T>(
  deploys: T[],
  events: LifecycleEvent[],
  at: (deploy: T) => DateInput,
): TimelineItem<T>[] {
  const entries: Array<{ at: number; order: number; item: TimelineItem<T> }> = [
    ...deploys.map((deploy) => ({
      at: toDate(at(deploy))?.getTime() ?? 0,
      order: 0,
      item: { kind: "deploy", deploy } as TimelineItem<T>,
    })),
    ...events.map((event) => ({
      at: event.at,
      order: 1,
      item: { kind: "lifecycle", event } as TimelineItem<T>,
    })),
  ];

  return entries
    .sort((a, b) => b.at - a.at || a.order - b.order)
    .map((entry) => entry.item);
}
