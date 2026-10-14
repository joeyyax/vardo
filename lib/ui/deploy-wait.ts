// Time a deploy spends waiting on locks and queues, from the deploy stream's wait events.

import type { WaitReason } from "@/lib/docker/deploy-logger";
import type { StatusMarkState } from "@/lib/ui/status-colors";

export type { WaitReason };

/** `ahead` and `total` place a deploy in a queue: 0 ahead of 3 is first of 3. `eta` is when it should start, in ms. */
export type QueuePlace = { ahead?: number; total?: number; eta?: number };

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
  const { reason, ahead, total, eta, streamId } = data as Record<string, unknown>;
  if (typeof streamId !== "string") return null;
  if (reason !== null && !isWaitReason(reason)) return null;
  const etaMs = typeof eta === "string" ? Date.parse(eta) : NaN;
  return {
    reason: reason as WaitReason | null,
    ahead: typeof ahead === "number" ? ahead : undefined,
    total: typeof total === "number" ? total : undefined,
    eta: Number.isNaN(etaMs) ? undefined : etaMs,
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
    const place = { ahead: event.ahead, total: event.total, eta: event.eta };
    if (current?.reason === event.reason) return { ...state, ...seen, current: { ...current, ...place } };
    const closedMs = current ? state.closedMs + Math.max(0, at - current.since) : state.closedMs;
    return { ...seen, closedMs, current: { reason: event.reason, ...place, since: at } };
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
  waitEta?: Date | string | null;
}): HeldDeploy | null {
  if (d.status !== "queued" && d.status !== "running") return null;
  const reason = isWaitReason(d.waitReason) ? d.waitReason : null;
  if (!reason && d.status === "running") return null;
  return {
    reason,
    ...(reason && d.waitAhead != null ? { ahead: d.waitAhead } : {}),
    ...(reason && d.waitTotal != null ? { total: d.waitTotal } : {}),
    ...(reason && d.waitEta ? { eta: new Date(d.waitEta).getTime() } : {}),
    since: d.waitingSince ? new Date(d.waitingSince).getTime() : null,
    queued: d.status === "queued",
  };
}

/** The stream's waits, or the row's open wait until the stream reports one. */
export function seedWait(state: WaitState, hold: HeldDeploy | null): WaitState {
  if (state.heard || !hold?.reason || hold.since === null) return state;
  return { ...state, current: { reason: hold.reason, ahead: hold.ahead, total: hold.total, eta: hold.eta, since: hold.since } };
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

/** "1st", "2nd", "3rd", "11th", "21st". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

/** "about 6 min", or "less than a minute". */
export function aboutMinutes(ms: number): string {
  return ms < 60_000 ? "less than a minute" : `about ${Math.round(ms / 60_000)} min`;
}

/** A deploy's place in the deploy or build line, with the estimate when there is one. */
export function lineLabel(line: "deploy" | "build", { ahead, eta }: QueuePlace, now: number | null): string {
  const place = ahead != null && ahead >= 0 ? ahead + 1 : null;
  const left = eta != null && now != null ? eta - now : null;
  const build = line === "build";
  if (place === 1) return left !== null ? (build ? "Building next" : "Starts next") : build ? "Next to build" : "Next in line";
  const starts = left !== null ? `${build ? "Build starts" : "Starts"} in ${aboutMinutes(left)}` : null;
  if (place === null) return starts ?? (build ? "Queued to build" : "Queued");
  return starts ? `${starts} · ${ordinal(place)} in line` : `${ordinal(place)} in line${build ? " to build" : ""}`;
}

/** Queued before work starts, Deploying once it has. */
export type DeployWord = "Preparing" | "Queued" | "Starting" | "Deploying";

export type DeployView = {
  word: DeployWord;
  /** The row label and the card's line. */
  label: string;
  /** Mark color: amber only when no worker is running. */
  tone: "neutral" | "warn" | "info";
  /** Why a plain Queued is queued. */
  why?: string;
  /** The strip step shown held. */
  held?: "queued" | "clone" | "build";
};

const WHY: Partial<Record<WaitReason, string>> = {
  worker: "The worker is offline",
  exclusive: "Vardo is updating",
  app: "This app is already deploying",
  checkout: "Another deploy of this app is using its checkout",
};

/** A queued row in an app's deploy list: its slot line when it has one, else its place among the app's queued deploys. */
export function queuedRowLabel(hold: HeldDeploy | null, place: number, now: number | null): string {
  return hold?.reason === "deploy-slot" ? lineLabel("deploy", hold, now) : lineLabel("deploy", { ahead: place - 1 }, null);
}

/** How an in-flight deploy reads, from its status, the request's hold, what it waits on and whether a phase has started. `now` counts the estimate down. */
export function deployView({
  queued,
  preparing = false,
  wait,
  started,
  now = null,
}: {
  queued: boolean;
  preparing?: boolean;
  wait: (QueuePlace & { reason: WaitReason | null }) | null;
  started: boolean;
  now?: number | null;
}): DeployView {
  const reason = wait?.reason ?? null;
  if (reason === "build-slot") return { word: "Deploying", label: lineLabel("build", wait!, now), tone: "neutral", held: "build" };
  if (reason === "checkout") return { word: "Deploying", label: "Queued", tone: "neutral", why: WHY.checkout, held: "clone" };
  if (queued || reason) {
    if (preparing) return { word: "Preparing", label: "Preparing", tone: "neutral", held: "queued" };
    const label = reason === "deploy-slot" ? lineLabel("deploy", wait!, now) : "Queued";
    return { word: "Queued", label, tone: reason === "worker" ? "warn" : "neutral", why: reason ? WHY[reason] : undefined, held: "queued" };
  }
  if (!started) return { word: "Starting", label: "Starting", tone: "info" };
  return { word: "Deploying", label: "Deploying", tone: "info" };
}

/** How a deploy reads from its open stream, with the row filling in until the stream reports. */
export function streamView(
  stream: { wait: WaitState; stages: Record<string, string> },
  row: { status: string; stage?: string | null; request?: { held?: boolean } | null },
  now: number | null = null,
): DeployView {
  const started = Object.keys(stream.stages).length > 0 || (row.status === "running" && !!row.stage);
  return deployView({
    queued: row.status === "queued" && !started,
    preparing: !!row.request?.held,
    wait: deployWaitOf(stream, row.status),
    started,
    now,
  });
}

/** A ring in the view's tone: gray queued, amber with no worker, blue deploying. */
export function deployMarkOf(view: DeployView): StatusMarkState {
  return { tone: view.tone, pending: true, label: view.word };
}

/** Before work starts: counted as queued rather than deploying. */
export function isQueuedView(view: DeployView): boolean {
  return view.word === "Queued" || view.word === "Preparing";
}

/** "2m 48s", "45s". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** The deploy card's line and meta, the same on the app page and the projects panel. */
export function deployCardText(
  view: DeployView,
  clock: DeployClock,
  typicalMs: number | null,
): { line: string; meta: string | null } {
  if (clock.wait) return { line: view.label, meta: null };
  const line =
    typicalMs === null
      ? "No earlier deploy to judge by"
      : clock.workingMs < typicalMs
        ? `About ${formatSpan(typicalMs - clock.workingMs)} left`
        : "Taking longer than last time";
  const meta = [
    `${formatSpan(clock.workingMs)} so far`,
    clock.waitedMs >= 1000 ? `queued ${formatSpan(clock.waitedMs)} first` : null,
    typicalMs !== null ? `last deploy took ${formatSpan(typicalMs)}` : null,
  ];
  return { line, meta: meta.filter(Boolean).join(" · ") };
}

/** The strip's first step: its label until cloning starts, then done. */
export function queuedStep(view: DeployView): { label: string; state: "done" | "held" | "now" } {
  if (view.word === "Deploying") return { label: "Queued", state: "done" };
  if (view.word === "Starting") return { label: "Starting", state: "now" };
  return { label: view.word, state: "held" };
}
