// Watches cgroup OOM counters: the fleet total is logged as a windowed rate; kills in running containers notify.

import { logger } from "@/lib/logger";
import { readContainerOomKills, readFleetOomKills } from "./oom-counter";

const log = logger.child("oom-watch");

/** How long kills accumulate before the fleet total is reported. */
export const OOM_WINDOW_MS = 60 * 60_000;

/** One running container to check for kills inside it. */
export type OomSubject = {
  organizationId: string;
  appId: string;
  appName: string;
  containerId: string;
  containerName: string;
  /** Container's cgroup memory limit in bytes. 0 means none was set. */
  memoryLimit: number;
};

/** Kills since the last reading. A counter that went backwards (host reboot) counts in full. */
export function oomDelta(prev: number | null, next: number): number {
  if (prev === null) return 0;
  return next < prev ? next : next - prev;
}

/** Kills per day implied by a count over a window. */
export function killsPerDay(kills: number, windowMs: number): number {
  if (windowMs <= 0) return 0;
  return (kills / windowMs) * 86_400_000;
}

/** Operator summary of a window's kills, split into attributed and anonymous. */
export function oomWindowSummary(
  kills: number,
  windowMs: number,
  attributed: { containerName: string; kills: number }[],
): string {
  const rate = Math.round(killsPerDay(kills, windowMs));
  const named = attributed.reduce((n, a) => n + a.kills, 0);
  const parts = [
    `${kills} OOM kill(s) across the fleet in the last ${Math.round(windowMs / 60_000)}m (~${rate}/day)`,
  ];
  if (named > 0) {
    const who = attributed.map((a) => `${a.containerName} (${a.kills})`).join(", ");
    parts.push(`${named} attributed: ${who}`);
  }
  const anonymous = kills - named;
  if (anonymous > 0) {
    parts.push(`${anonymous} in cgroups that no longer exist — the container was replaced`);
  }
  return parts.join(". ");
}

let fleetLast: number | null = null;
let windowKills = 0;
let windowSince = 0;
let windowAttributed = new Map<string, number>();
/** Last reported count per container, so a standing kill is not re-reported. */
const containerLast = new Map<string, number>();
let warnedUnreadable = false;

/** Drops state so a test starts from a known reading. */
export function resetOomWatch(): void {
  fleetLast = null;
  windowKills = 0;
  windowSince = 0;
  windowAttributed = new Map();
  containerLast.clear();
  warnedUnreadable = false;
}

/** Reports kills inside containers that are still running. */
async function reportContainerKills(subjects: OomSubject[], now: number): Promise<void> {
  const live = new Set(subjects.map((s) => s.containerId));
  for (const id of containerLast.keys()) {
    if (!live.has(id)) containerLast.delete(id);
  }

  const fresh: { subject: OomSubject; kills: number }[] = [];
  for (const subject of subjects) {
    const count = await readContainerOomKills(subject.containerId);
    if (count === null) continue;

    const seen = containerLast.get(subject.containerId) ?? 0;
    containerLast.set(subject.containerId, count);
    // A count that dropped is a recreated cgroup, not a kill.
    if (count > seen) fresh.push({ subject, kills: count - seen });
  }
  if (fresh.length === 0) return;

  for (const { subject, kills } of fresh) {
    windowAttributed.set(
      subject.containerName,
      (windowAttributed.get(subject.containerName) ?? 0) + kills,
    );
  }

  const { emit } = await import("@/lib/notifications/dispatch").catch(() => ({ emit: null }));
  for (const { subject, kills } of fresh) {
    const host = subject.memoryLimit <= 0;
    log.error(
      `OOM kill inside running container ${subject.containerName} (app ${subject.appName}, x${kills})`,
    );
    emit?.(subject.organizationId, {
      type: "app.oom-killed",
      title: host
        ? `Killed for host memory: ${subject.appName}`
        : `Killed at memory limit: ${subject.appName}`,
      message: host
        ? `The kernel killed a process inside ${subject.containerName}, which has no memory limit of its own, because the host ran out of memory. The container is still running, so this leaves no exit status behind — only the cgroup counter recorded it. Free memory on the host, or give this app a limit.`
        : `A process inside ${subject.containerName} was killed at the container's memory limit. The container is still running, so whatever was killed was a child process rather than the container itself. Raise the limit, or find out what is using more than it was given.`,
      appId: subject.appId,
      appName: subject.appName,
      containerName: subject.containerName,
      containerId: subject.containerId,
      kind: host ? "oom-host" : "oom-limit",
      exitCode: 137,
      at: new Date(now).toISOString(),
    });
  }
}

/** Read both counters and report the window. Never throws; runs inside the reconciler tick. */
export async function tickOomWatch(
  subjects: OomSubject[],
  now: number = Date.now(),
): Promise<void> {
  const fleet = await readFleetOomKills();
  if (fleet === null) {
    // Host cgroup root not mounted. Warned once.
    if (!warnedUnreadable) {
      warnedUnreadable = true;
      log.warn(
        "Host cgroup counters are not readable — mount the host cgroup root read-only at /host-cgroup to count OOM kills. Only kills on a container found stopped will be reported.",
      );
    }
    return;
  }
  warnedUnreadable = false;

  if (windowSince === 0) windowSince = now;
  windowKills += oomDelta(fleetLast, fleet);
  fleetLast = fleet;

  await reportContainerKills(subjects, now);

  const elapsed = now - windowSince;
  if (elapsed < OOM_WINDOW_MS) return;

  if (windowKills > 0) {
    const attributed = [...windowAttributed].map(([containerName, kills]) => ({
      containerName,
      kills,
    }));
    log.warn(oomWindowSummary(windowKills, elapsed, attributed));
  }
  windowKills = 0;
  windowSince = now;
  windowAttributed = new Map();
}
