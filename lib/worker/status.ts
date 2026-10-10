import { isFeatureEnabled } from "@/lib/config/features";
import { instanceId } from "./instance";
import { readJobs, type JobState } from "./jobs";
import { leasesEnabled, readLeases } from "./lease";
import { LOOP_REGISTRY } from "./registry";
import { startedLoops } from "./start";

export type LoopStatus = {
  name: string;
  roles: string[];
  singleton: boolean;
  feature: string | null;
  /** False while the loop's feature flag is off. */
  enabled: boolean;
  /** Whether this process runs the loop. */
  runningHere: boolean;
  lease: { holder: string; epoch: number; expiresAt: string; live: boolean } | null;
  state: JobState;
  stale: boolean;
  lastTickAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  intervalMs: number | null;
  lastHolder: string | null;
};

export type LoopsReport = { instance: string; leases: boolean; checkedAt: string; loops: LoopStatus[] };

/** Every registered loop with its lease holder and last heartbeat, for the system screen. */
export async function readLoopStatus(): Promise<LoopsReport> {
  const [{ now, jobs }, leases] = await Promise.all([readJobs(LOOP_REGISTRY.map((e) => e.name)), readLeases()]);
  const leaseByName = new Map(leases.map((l) => [l.name, l]));
  const running = startedLoops();

  const loops = LOOP_REGISTRY.map((entry, i): LoopStatus => {
    const { state, row } = jobs[i];
    const lease = leaseByName.get(entry.name);
    return {
      name: entry.name,
      roles: entry.roles,
      singleton: entry.singleton,
      feature: entry.feature ?? null,
      enabled: entry.feature ? isFeatureEnabled(entry.feature) : true,
      runningHere: running.get(entry.name)?.started ?? false,
      lease: lease
        ? { holder: lease.holder, epoch: lease.epoch, expiresAt: lease.expiresAt.toISOString(), live: lease.live }
        : null,
      state,
      stale: state === "stale",
      lastTickAt: row?.lastTickAt.toISOString() ?? null,
      lastOkAt: row?.lastOkAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      intervalMs: row?.intervalMs ?? null,
      lastHolder: row?.holder ?? null,
    };
  });

  return { instance: instanceId(), leases: leasesEnabled(), checkedAt: now.toISOString(), loops };
}
