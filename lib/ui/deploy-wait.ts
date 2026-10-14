// Time a deploy spends waiting on locks and queues, from the deploy stream's wait events.

export type WaitReason = "app" | "deploy-slot" | "build-slot" | "checkout";

export type WaitEvent = { reason: WaitReason | null; ahead?: number; streamId: string };

export type WaitState = {
  /** The open wait, stamped by its stream id. */
  current: { reason: WaitReason; ahead?: number; since: number } | null;
  /** Total of the waits that have ended. */
  closedMs: number;
  /** A wait event has arrived, so the stream speaks for the deploy. */
  heard: boolean;
};

export const NO_WAIT: WaitState = { current: null, closedMs: 0, heard: false };

/** Milliseconds from a Redis stream id like `1760000000000-0`, or null when it isn't one. */
export function streamIdMs(id: string | undefined): number | null {
  const match = id ? /^(\d+)-\d+$/.exec(id) : null;
  return match ? Number(match[1]) : null;
}

const REASONS = new Set<string>(["app", "deploy-slot", "build-slot", "checkout"]);

/** A `wait` event's payload, or null when it doesn't match the contract. */
export function parseWaitEvent(data: unknown): WaitEvent | null {
  if (!data || typeof data !== "object") return null;
  const { reason, ahead, streamId } = data as Record<string, unknown>;
  if (typeof streamId !== "string") return null;
  if (reason !== null && !(typeof reason === "string" && REASONS.has(reason))) return null;
  return { reason: reason as WaitReason | null, ahead: typeof ahead === "number" ? ahead : undefined, streamId };
}

/** Folds one wait event into the running state. */
export function applyWait(state: WaitState, event: WaitEvent): WaitState {
  const at = streamIdMs(event.streamId);
  if (at === null) return state;
  const { current } = state;

  if (event.reason) {
    if (current?.reason === event.reason) return { ...state, heard: true, current: { ...current, ahead: event.ahead } };
    const closedMs = current ? state.closedMs + Math.max(0, at - current.since) : state.closedMs;
    return { closedMs, heard: true, current: { reason: event.reason, ahead: event.ahead, since: at } };
  }

  if (!current) return { ...state, heard: true };
  return { current: null, closedMs: state.closedMs + Math.max(0, at - current.since), heard: true };
}

export type ActiveWait = { reason: WaitReason | null; ahead?: number; since: number };

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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What a waiting deploy is waiting for, in a few words. */
export function waitLabel(reason: WaitReason | null, ahead?: number): string {
  const queue = ahead && ahead > 0 ? ahead : 0;
  switch (reason) {
    case "deploy-slot":
      return queue ? `Queued behind ${plural(queue, "other deploy")}` : "Queued for a deploy slot";
    case "app":
      return "Queued behind this app's running deploy";
    case "build-slot":
      return queue ? `Waiting for the builder, ${plural(queue, "build")} ahead` : "Waiting for the builder";
    case "checkout":
      return "Waiting for another deploy's checkout";
    default:
      return "Queued";
  }
}

/** The one-word status for a waiting deploy: queued before it runs, waiting once it has. */
export function waitWord(reason: WaitReason | null): "Queued" | "Waiting" {
  return reason === "build-slot" || reason === "checkout" ? "Waiting" : "Queued";
}
