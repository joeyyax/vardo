import { isFeatureEnabled } from "@/lib/config/features";
import { logger } from "@/lib/logger";
import type { IntervalLoop, LoopRole } from "./interval-loop";
import { leasesEnabled } from "./lease";
import { LOOP_REGISTRY, type LoopEntry } from "./registry";

const log = logger.child("loops");

export type StartLoopsOptions = {
  role: LoopRole;
  /** Boot steps a loop can wait on; a missing one doesn't hold its loops back. */
  ready?: Partial<Record<NonNullable<LoopEntry["after"]>, Promise<unknown>>>;
  registry?: LoopEntry[];
};

const g = globalThis as unknown as { __vardo_started_loops?: Map<string, IntervalLoop> };
const started = (g.__vardo_started_loops ??= new Map<string, IntervalLoop>());

async function startEntry(entry: LoopEntry, role: LoopRole, ready: StartLoopsOptions["ready"]): Promise<void> {
  if (entry.after) await ready?.[entry.after]?.catch(() => {});
  if (entry.feature && !isFeatureEnabled(entry.feature)) {
    log.info(`${entry.name}: ${entry.feature} is off, not started`);
    return;
  }
  const loop = await entry.load();
  if (loop.name !== entry.name) throw new Error(`Registry entry ${entry.name} loaded loop ${loop.name}`);
  if (entry.start) await entry.start();
  else loop.start({ role, singleton: entry.singleton, feature: entry.feature });
  started.set(entry.name, loop);
}

/** Starts every registered loop for this role. A loop that fails to start is logged and skipped. */
export async function startLoops({ role, ready, registry = LOOP_REGISTRY }: StartLoopsOptions): Promise<void> {
  const entries = registry.filter((entry) => entry.roles.includes(role));
  if (!leasesEnabled()) log.warn("VARDO_LEASES=off: singleton loops run in every process");
  const results = await Promise.allSettled(entries.map((entry) => startEntry(entry, role, ready)));
  results.forEach((result, i) => {
    if (result.status === "rejected") log.error(`Failed to start ${entries[i].name}:`, result.reason);
  });
  log.info(`Started ${started.size} of ${entries.length} loop(s) for ${role}`);
}

/** Loops this process started, by name. */
export function startedLoops(): ReadonlyMap<string, IntervalLoop> {
  return started;
}
