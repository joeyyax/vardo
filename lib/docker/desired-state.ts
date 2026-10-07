// ---------------------------------------------------------------------------
// Desired state for critical apps
//
// Whether a stopped container should be running, judged from what Vardo
// recorded rather than Docker's manual-stop flag, which a failed restart also
// sets. Pure; the health monitor gathers the inputs and acts on the verdict.
// ---------------------------------------------------------------------------

import type { Slot } from "./slots";

/** Exited this recently, a Vardo operation may still be mid-flight. */
export const EXIT_SETTLE_MS = 60_000;

/** Slot a container's compose project names: blue, green, shared, or null when unslotted. */
export function projectSlot(project: string | undefined): Slot | "shared" | null {
  if (!project) return null;
  const m = /-(blue|green|shared)$/.exec(project);
  return m ? (m[1] as Slot | "shared") : null;
}

/** An app's tier, with a decomposed child's null inheriting its parent's. */
export function resolvePriority(
  app: { priority: string | null },
  child?: { priority: string | null } | null,
): string {
  return child?.priority ?? app.priority ?? "standard";
}

/** A container's self-heal settings, a compose child's own over its parent's. */
export function resolveSelfHeal(
  app: { priority: string | null; autoRestartUnhealthy: boolean | null },
  child?: { priority: string | null; autoRestartUnhealthy: boolean | null } | null,
): { priority: string; autoRestartUnhealthy: boolean | null } {
  return {
    priority: resolvePriority(app, child),
    autoRestartUnhealthy: child?.autoRestartUnhealthy ?? app.autoRestartUnhealthy,
  };
}

/** Whether a stopped container of this app is kept running. Explicitly
 *  disabling auto-restart opts a critical app out. */
export function keepsRunning(opts: {
  priority: string;
  autoRestartUnhealthy: boolean | null;
}): boolean {
  return opts.priority === "critical" && opts.autoRestartUnhealthy !== false;
}

const STOPPED = new Set(["exited", "dead", "created"]);

export type StopIntent = {
  /** Docker State.Status. */
  status: string;
  exitCode: number;
  /** Compose-format restart policy from inspect. */
  restartPolicy: string;
  /** Epoch ms the container last started, or null. */
  startedAt: number | null;
  appStatus: string;
  parked: boolean;
  /** Epoch ms of the newest operator stop on the app, or null. */
  operatorStoppedAt: number | null;
  /** Holder from stop-holds, or null. */
  heldBy: string | null;
  slot: Slot | "shared" | null;
  /** `current` symlink target, or null when unreadable. */
  currentSlot: Slot | null;
  /** Another container for the same service and environment is running. */
  siblingRunning: boolean;
};

/**
 * Why a stopped container is meant to stay stopped, or null when nothing
 * asked for it. Every branch is a way Vardo records a stop.
 */
export function intendedStopReason(
  s: StopIntent,
  /** The stop came from Vardo's own restart, so a clean exit is no signal. */
  ownRestart = false,
): string | null {
  if (!STOPPED.has(s.status)) return `container is ${s.status}`;
  if (s.heldBy) return `held by ${s.heldBy}`;
  if (s.appStatus === "deploying") return "a deploy owns the app";
  if (s.parked) return "app is parked";
  if (s.operatorStoppedAt !== null && (s.startedAt === null || s.operatorStoppedAt >= s.startedAt)) {
    return "stopped by an operator";
  }
  const policy = s.restartPolicy || "no";
  if (policy === "no") return "restart policy is no";
  if (s.exitCode === 0 && !ownRestart) return "exited cleanly";
  if ((s.slot === "blue" || s.slot === "green") && s.currentSlot !== s.slot) {
    return s.currentSlot ? `${s.slot} is not the current slot` : "no current slot to compare";
  }
  if (s.siblingRunning) return "another container is serving";
  return null;
}

export type DesiredStateDecision = "leave" | "settle" | "start" | "backoff" | "giveup";

/** What the reconciler does about one stopped container. */
export function decideDesiredState(opts: {
  intendedStop: string | null;
  finishedAt: number | null;
  recentRestarts: number[];
  gaveUp: boolean;
  maxRestarts: number;
  backoffMs: number;
  now: number;
}): DesiredStateDecision {
  if (opts.intendedStop !== null) return "leave";
  if (opts.finishedAt === null || opts.now - opts.finishedAt < EXIT_SETTLE_MS) return "settle";
  if (opts.gaveUp) return "leave";
  if (opts.recentRestarts.length >= opts.maxRestarts) return "giveup";
  const last = opts.recentRestarts[opts.recentRestarts.length - 1];
  if (last !== undefined && opts.now - last < opts.backoffMs) return "backoff";
  return "start";
}
