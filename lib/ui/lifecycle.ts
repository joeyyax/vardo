// Operator restart, stop and start events for the Deployments timeline.
// Docker and self-heal restarts belong to Stability, not here.

import { toDate, type DateInput } from "@/lib/ui/relative-time";

/** Activity actions the Deployments timeline is built from. */
export const LIFECYCLE_ACTIONS = ["app.restarted", "app.stopped", "app.started"] as const;

export type LifecycleKind = "restarted" | "stopped" | "started";

/** What one click acted on: the app, one compose service, or a whole stack. */
export type LifecycleScope = "app" | "service" | "stack";

/** How the action reached Vardo. Absent means the UI. */
export type LifecycleTrigger = "api" | "mcp";

/** What Docker reported once the command returned. Mirrors ObservedStatus. */
export type LifecycleStatus = "active" | "error" | "stopped" | "missing";

/** Matches AppRow's `note` shape. */
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
  /** Epoch ms. */
  at: number;
  label: string;
  /** Who did it and how, or null when neither is known. */
  detail: string | null;
  /** How long the command took, or null on a row that recorded no span. */
  durationMs: number | null;
  /** How it ended, worst first. */
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

/** A non-negative millisecond span, or undefined. */
function readMs(metadata: unknown, key: string): number | undefined {
  const value = field(metadata, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const STATUSES = new Set<string>(Object.keys(STATUS_LABELS));

function readStatus(metadata: unknown): LifecycleStatus | undefined {
  const value = read(metadata, "status");
  return value && STATUSES.has(value) ? (value as LifecycleStatus) : undefined;
}

/** Action phrase naming the app, a service or the stack. */
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

/** "by Joey", "by Joey via API" or "by Vardo". */
export function lifecycleDetail(
  actor: { name: string | null; email: string } | null,
  trigger?: string | null,
): string | null {
  const who = actor ? actor.name?.trim() || actor.email : "Vardo";
  const how = trigger ? TRIGGER_LABELS[trigger] ?? trigger : null;
  return how ? `by ${who} via ${how}` : `by ${who}`;
}

/** Notes on how the action ended, worst first. A missing status adds no note; absent isn't success. */
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

/** Split events into those since the live deploy and those before it. */
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

/** Deploys and lifecycle events merged newest first. Deploys win ties. */
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
