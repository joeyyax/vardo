// Time a deploy spends waiting on locks and queues, from the deploy stream's wait events.

import type { WaitReason } from "@/lib/docker/deploy-logger";

export type { WaitReason };

/** `ahead` and `total` place a deploy in a queue: 0 ahead of 3 is first of 3. */
export type QueuePlace = { ahead?: number; total?: number };

export type WaitEvent = QueuePlace & { reason: WaitReason | null; streamId: string };

export type WaitState = {
  /** The open wait, stamped by its stream id. */
  current: (QueuePlace & { reason: WaitReason; since: number }) | null;
  /** Total of the waits that have ended. */
  closedMs: number;
  /** A wait event has arrived, so the stream speaks for the deploy. */
  heard: boolean;
  /** Stream id of the last event applied, so a replay doesn't count twice. */
  lastId: string | null;
};

export const NO_WAIT: WaitState = { current: null, closedMs: 0, heard: false, lastId: null };

/** Milliseconds from a Redis stream id like `1760000000000-0`, or null when it isn't one. */
export function streamIdMs(id: string | undefined): number | null {
  const match = id ? /^(\d+)-\d+$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

/** Whether stream id `a` comes after `b`. */
function streamIdAfter(a: string, b: string): boolean {
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  return am !== bm ? am > bm : as > bs;
}

const REASONS = new Set<string>(["app", "deploy-slot", "build-slot", "checkout", "worker", "exclusive"]);

/** Whether a value is a wait reason the UI knows. */
export function isWaitReason(value: unknown): value is WaitReason {
  return typeof value === "string" && REASONS.has(value);
}

/** A `wait` event's payload, or null when it doesn't match the contract. */
export function parseWaitEvent(data: unknown): WaitEvent | null {
  if (!data || typeof data !== "object") return null;
  const { reason, ahead, total, streamId } = data as Record<string, unknown>;
  if (typeof streamId !== "string") return null;
  if (reason !== null && !isWaitReason(reason)) return null;
  return {
    reason: reason as WaitReason | null,
    ahead: typeof ahead === "number" ? ahead : undefined,
    total: typeof total === "number" ? total : undefined,
    streamId,
  };
}

/** Folds one wait event into the running state. */
export function applyWait(state: WaitState, event: WaitEvent): WaitState {
  const at = streamIdMs(event.streamId);
  if (at === null || (state.lastId && !streamIdAfter(event.streamId, state.lastId))) return state;
  const { current } = state;
  const seen = { heard: true, lastId: event.streamId };

  if (event.reason) {
    if (current?.reason === event.reason) return { ...state, ...seen, current: { ...current, ahead: event.ahead, total: event.total } };
    const closedMs = current ? state.closedMs + Math.max(0, at - current.since) : state.closedMs;
    return { ...seen, closedMs, current: { reason: event.reason, ahead: event.ahead, total: event.total, since: at } };
  }

  if (!current) return { ...state, ...seen };
  return { ...seen, current: null, closedMs: state.closedMs + Math.max(0, at - current.since) };
}

export type ActiveWait = QueuePlace & { reason: WaitReason | null; since: number };

export type DeployClock = {
  /** What the deploy is waiting on now, or null while it works. */
  wait: ActiveWait | null;
  waitedMs: number;
  /** Time since start minus time spent waiting. */
  workingMs: number;
};

/** Splits a deploy's time since start into waiting and working. A queued row the stream hasn't spoken for counts as waiting. */
export function deployClock(
  state: WaitState,
  { startedAt, now, queued }: { startedAt: number; now: number; queued: boolean },
): DeployClock {
  const total = Math.max(0, now - startedAt);
  if (!state.current && !state.heard && queued) {
    return { wait: { reason: null, since: startedAt }, waitedMs: total, workingMs: 0 };
  }
  const open = state.current ? Math.max(0, now - state.current.since) : 0;
  const waitedMs = Math.min(total, state.closedMs + open);
  return { wait: state.current, waitedMs, workingMs: total - waitedMs };
}

export type HeldDeploy = QueuePlace & { reason: WaitReason | null; since: number | null; queued: boolean };

/** What holds an in-flight deploy row still, from its wait columns. Null while it works or once it's done. */
export function rowHold(d: {
  status: string;
  waitReason?: string | null;
  waitingSince?: Date | string | null;
  waitAhead?: number | null;
  waitTotal?: number | null;
}): HeldDeploy | null {
  if (d.status !== "queued" && d.status !== "running") return null;
  const reason = isWaitReason(d.waitReason) ? d.waitReason : null;
  if (!reason && d.status === "running") return null;
  return {
    reason,
    ...(reason && d.waitAhead != null ? { ahead: d.waitAhead } : {}),
    ...(reason && d.waitTotal != null ? { total: d.waitTotal } : {}),
    since: d.waitingSince ? new Date(d.waitingSince).getTime() : null,
    queued: d.status === "queued",
  };
}

/** The stream's waits, or the row's open wait until the stream reports one. */
export function seedWait(state: WaitState, hold: HeldDeploy | null): WaitState {
  if (state.heard || !hold?.reason || hold.since === null) return state;
  return { ...state, current: { reason: hold.reason, ahead: hold.ahead, total: hold.total, since: hold.since } };
}

/** A held deploy in a few words, for a list row. */
export function holdLabel(hold: HeldDeploy): string {
  return hold.reason ? waitLabel(hold) : "Deploy queued";
}

/** The deploy to show from a newest-first list: the running one, else the first in line. */
export function activeDeploy<D extends { status: string }>(deployments: D[]): D | null {
  return deployments.find((d) => d.status === "running") ?? deployments.findLast((d) => d.status === "queued") ?? null;
}

/** `deployClock` for a deploy's stream state and row: a queued row counts until a stage or wait event lands. */
export function deployClockOf(
  { wait, stages }: { wait: WaitState; stages: Record<string, string> },
  { startedAt, status, now }: { startedAt: Date | string | number; status?: string; now: number },
): DeployClock {
  const queued = status === "queued" && Object.keys(stages).length === 0;
  return deployClock(wait, { startedAt: new Date(startedAt).getTime(), now, queued });
}

/** The lock or queue holding the deploy, or null while it works. */
export function deployWaitOf(stream: { wait: WaitState; stages: Record<string, string> }, status?: string): ActiveWait | null {
  return deployClockOf(stream, { startedAt: 0, status, now: 0 }).wait;
}

/** " (2 of 3)", " (2)" without a total, or nothing without a place. */
export function queuePlace({ ahead, total }: QueuePlace): string {
  if (ahead == null || ahead < 0) return "";
  const place = ahead + 1;
  return total != null && total >= place ? ` (${place} of ${total})` : ` (${place})`;
}

/** What a waiting deploy is waiting for, in a few words. */
export function waitLabel({ reason, ...place }: QueuePlace & { reason: WaitReason | null }): string {
  switch (reason) {
    case "deploy-slot":
      return `Queued${queuePlace(place)}`;
    case "app":
      return "Queued behind this app's running deploy";
    case "build-slot":
      return `Queued for the builder${queuePlace(place)}`;
    case "checkout":
      return "Waiting for another deploy's checkout";
    case "worker":
      return "Waiting for the worker to come back";
    case "exclusive":
      return "Waiting for Vardo's own update to finish";
    default:
      return "Queued";
  }
}

/** The one-word status for a waiting deploy: queued before it runs, waiting once it has. */
export function waitWord(reason: WaitReason | null): "Queued" | "Waiting" {
  return reason === "build-slot" || reason === "checkout" ? "Waiting" : "Queued";
}
