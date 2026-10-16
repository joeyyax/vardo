// Web's side of the worker: hands its instance-wide loops to a present worker and takes them back when it goes.

import { logger } from "@/lib/logger";
import { IntervalLoop } from "./interval-loop";
import { HANDOFF_CHECK_MS, WEB_RESUME_AFTER_MS, loopsInWeb, webLoopsEnabled, type LoopsInWeb } from "./mode";
import { isPresent, readWorkers } from "./presence";
import type { LoopEntry } from "./registry";
import { isDeferrable, startLoops, stopLoops, type StartLoopsOptions } from "./start";

const log = logger.child("loops");

export type HandoffState = {
  /** Web's deferrable loops are stopped. */
  deferred: boolean;
  /** Last time a present worker was seen, epoch ms. */
  lastPresentAt: number | null;
};

export type HandoffAction = "defer" | "resume" | "stay";

/** What web does with its deferrable loops after one check. */
export function decideHandoff(
  state: HandoffState,
  mode: LoopsInWeb,
  present: boolean,
  now: number,
  resumeAfterMs = WEB_RESUME_AFTER_MS,
): HandoffAction {
  if (mode === "always") return state.deferred ? "resume" : "stay";
  if (mode === "never") return state.deferred ? "stay" : "defer";
  if (present) return state.deferred ? "stay" : "defer";
  if (!state.deferred) return "stay";
  const since = state.lastPresentAt ?? 0;
  return now - since >= resumeAfterMs ? "resume" : "stay";
}

type Shared = {
  state: HandoffState;
  ready?: StartLoopsOptions["ready"];
};

// On globalThis: the stats route and instrumentation load separate copies of this module.
const g = globalThis as unknown as { __vardo_handoff?: Shared };
const shared: Shared = (g.__vardo_handoff ??= { state: { deferred: false, lastPresentAt: null } });

/** Whether this web process has handed its loops to a worker. */
export function loopsDeferredToWorker(): boolean {
  return shared.state.deferred;
}

/** Reads the worker table. Null when the read fails, which leaves the handoff as it is. */
async function presentNow(): Promise<boolean | null> {
  try {
    const { now, rows } = await readWorkers();
    return rows.some((row) => isPresent(row, now));
  } catch (err) {
    log.warn("Couldn't read the worker table:", err);
    return null;
  }
}

async function apply(action: HandoffAction): Promise<void> {
  if (action === "defer") {
    shared.state.deferred = true;
    const stopped = await stopLoops(isDeferrable);
    // A stats stream can start the collector outside the registry.
    const collector = await import("@/lib/metrics/collector");
    if (collector.isCollectorRunning()) await collector.stopCollector();
    log.info(`Loops deferred to worker (${stopped.length} stopped)`);
  } else if (action === "resume") {
    shared.state.deferred = false;
    log.warn(`No worker for ${Math.round(WEB_RESUME_AFTER_MS / 1000)}s, running loops in web again`);
    await startLoops({ role: "web", ready: shared.ready, only: isDeferrable });
  }
}

/** One check: reads the worker table and defers or resumes. */
export async function handoffPass(now = Date.now()): Promise<HandoffAction> {
  const mode = loopsInWeb();
  const present = await presentNow();
  if (present === null && mode === "auto") return "stay";
  if (present) shared.state.lastPresentAt = now;
  const action = decideHandoff(shared.state, mode, !!present, now);
  await apply(action);
  return action;
}

/**
 * Starts web's loops. With a worker already present, or VARDO_LOOPS_IN_WEB=never, the deferrable
 * ones stay stopped from the start.
 */
export async function startWebLoops(ready?: StartLoopsOptions["ready"]): Promise<void> {
  if (!webLoopsEnabled()) {
    log.info("Background loops off in development; set VARDO_DEV_WORKERS=1 to start them");
    return;
  }
  shared.ready = ready;
  const mode = loopsInWeb();
  let deferNow = mode === "never";
  if (mode === "auto" && (await presentNow())) {
    deferNow = true;
    shared.state.lastPresentAt = Date.now();
  }
  shared.state.deferred = deferNow;
  if (deferNow) log.info(`Loops deferred to worker (VARDO_LOOPS_IN_WEB=${mode})`);
  const only = deferNow ? (entry: LoopEntry) => !isDeferrable(entry) : undefined;
  await startLoops({ role: "web", ready, only });
}

export const workerHandoffLoop = new IntervalLoop({
  name: "worker-handoff",
  intervalMs: HANDOFF_CHECK_MS,
  log,
  run: () => handoffPass(),
});
