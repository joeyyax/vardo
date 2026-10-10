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
  /** Starts only the entries this accepts. */
  only?: (entry: LoopEntry) => boolean;
};

const g = globalThis as unknown as { __vardo_started_loops?: Map<string, { entry: LoopEntry; loop: IntervalLoop }> };
const started = (g.__vardo_started_loops ??= new Map<string, { entry: LoopEntry; loop: IntervalLoop }>());

/** Runs in both web and worker and serves the whole instance, so web hands it to a present worker. */
export function isDeferrable(entry: LoopEntry): boolean {
  return entry.roles.includes("web") && entry.roles.includes("worker") && !entry.perProcess;
}

async function startEntry(entry: LoopEntry, role: LoopRole, ready: StartLoopsOptions["ready"]): Promise<boolean> {
  if (started.has(entry.name)) return false;
  if (entry.after) await ready?.[entry.after]?.catch(() => {});
  if (entry.feature && !isFeatureEnabled(entry.feature)) {
    log.info(`${entry.name}: ${entry.feature} is off, not started`);
    return false;
  }
  const loop = await entry.load();
  if (loop.name !== entry.name) throw new Error(`Registry entry ${entry.name} loaded loop ${loop.name}`);
  if (entry.start) await entry.start(role);
  else loop.start({ role, singleton: entry.singleton, feature: entry.feature });
  started.set(entry.name, { entry, loop });
  return true;
}

/** Starts every registered loop for this role. A loop that fails to start is logged and skipped. */
export async function startLoops({ role, ready, registry = LOOP_REGISTRY, only }: StartLoopsOptions): Promise<void> {
  const entries = registry.filter((entry) => entry.roles.includes(role) && (only?.(entry) ?? true));
  if (!leasesEnabled()) log.warn("VARDO_LEASES=off: singleton loops run in every process");
  const results = await Promise.allSettled(entries.map((entry) => startEntry(entry, role, ready)));
  let count = 0;
  results.forEach((result, i) => {
    if (result.status === "rejected") log.error(`Failed to start ${entries[i].name}:`, result.reason);
    else if (result.value) count++;
  });
  log.info(`Started ${count} of ${entries.length} loop(s) for ${role}`);
}

/** Stops the started loops this accepts: each finishes its pass in flight and hands back its lease. */
export async function stopLoops(only: (entry: LoopEntry) => boolean = () => true): Promise<string[]> {
  const stopping = [...started.values()].filter(({ entry }) => only(entry));
  await Promise.allSettled(
    stopping.map(async ({ entry, loop }) => {
      try {
        await (entry.stop ? entry.stop() : loop.stop());
      } catch (err) {
        log.error(`Failed to stop ${entry.name}:`, err);
      } finally {
        started.delete(entry.name);
      }
    }),
  );
  return stopping.map(({ entry }) => entry.name);
}

/** Loops this process started, by name. */
export function startedLoops(): ReadonlyMap<string, IntervalLoop> {
  return new Map([...started].map(([name, { loop }]) => [name, loop]));
}
