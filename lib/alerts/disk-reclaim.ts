// A full disk reclaims before it alerts, so the email only goes out when a person has something to do.

import { logger } from "@/lib/logger";
import type { HostReclaimRun } from "@/lib/docker/host-reclaim/state";
import { HOST_RULES, type DiskFollowup, type HostSample } from "./host";

const log = logger.child("alerts");

/** A reclaim this recent counts; the alert doesn't wait for another. */
export const RECLAIM_COOLDOWN_MS = 60 * 60_000;
/** Longest the disk alert waits on a reclaim that can't run or won't finish. */
export const MAX_DEFER_MS = 20 * 60_000;
const FOLLOWUP_TTL_MS = 10 * 60_000;
const TOP_APPS = 3;

export type DiskStep =
  | { kind: "evaluate" }
  | { kind: "defer" }
  | { kind: "reclaim" };

/** What the alert pass does with a disk reading. Pure. */
export function diskStep(input: {
  percent: number | null;
  now: number;
  last: Pick<HostReclaimRun, "finishedAt"> | null;
  running: boolean;
  /** When this episode over the line started deferring, or null. */
  deferringSince: number | null;
}): DiskStep {
  const { percent, now, last, running, deferringSince } = input;
  if (percent === null || percent < HOST_RULES["host.disk"].warn) return { kind: "evaluate" };
  if (deferringSince !== null && now - deferringSince >= MAX_DEFER_MS) return { kind: "evaluate" };
  if (running) return { kind: "defer" };
  const lastAt = last ? Date.parse(last.finishedAt) : NaN;
  if (Number.isFinite(lastAt) && now - lastAt < RECLAIM_COOLDOWN_MS) return { kind: "evaluate" };
  return { kind: "reclaim" };
}

let running: Promise<unknown> | null = null;
let deferringSince: number | null = null;
let followup: { at: number; data: DiskFollowup } | null = null;

function startReclaim(): void {
  running = import("@/lib/docker/host-reclaim/run")
    .then(({ runHostReclaim }) => runHostReclaim("disk"))
    .catch((err) => log.error("Disk reclaim failed:", err))
    .finally(() => {
      running = null;
      followup = null;
    });
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function buildFollowup(last: HostReclaimRun | null, now: number): Promise<DiskFollowup> {
  const [{ freedBytes }, { getDiskSnapshot }, { findOrphanVolumes }, { findDetached }] = await Promise.all([
    import("@/lib/docker/host-reclaim/state"),
    import("@/lib/docker/disk-snapshot"),
    import("@/lib/docker/orphan-volumes"),
    import("@/lib/docker/detached-volumes"),
  ]);
  const [snapshot, orphans, detached] = await Promise.all([
    within(getDiskSnapshot(now), 30_000, null),
    within(findOrphanVolumes(), 30_000, null),
    within(findDetached(), 30_000, null),
  ]);

  const names = [...(orphans ?? []).map((v) => v.name), ...(detached?.volumes ?? []).map((v) => v.name)];
  let bytes: number | null = null;
  if (snapshot && names.length > 0) {
    const { getVolumeSizeBytes } = await import("@/lib/docker/disk-snapshot");
    const sizes = await Promise.all(names.map((n) => getVolumeSizeBytes(n, now).catch(() => null)));
    bytes = sizes.every((s) => s === null) ? null : sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  }

  return {
    reclaim: last ? { finishedAt: last.finishedAt, freedBytes: freedBytes(last), skipped: last.skipped } : null,
    reclaimableBytes: snapshot ? snapshot.usage.images.reclaimable + snapshot.usage.buildCache.reclaimable : null,
    unusedVolumes: orphans || detached ? { count: names.length, bytes } : null,
    topApps: snapshot
      ? [...snapshot.perProject.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_APPS)
          .map(([name, size]) => ({ name, bytes: size }))
      : [],
  };
}

/**
 * Runs before the host alerts. Over the line, it reclaims first and hides the disk reading until the
 * reclaim is done; the next pass reads the disk afresh and alerts only if it's still over.
 */
export async function settleDisk(
  disk: HostSample["disk"],
  now: number,
): Promise<{ disk: HostSample["disk"]; followup?: DiskFollowup }> {
  const percent = disk?.percent ?? null;
  if (percent === null || percent < HOST_RULES["host.disk"].warn) {
    deferringSince = null;
    return { disk };
  }

  const { getLastHostReclaim } = await import("@/lib/docker/host-reclaim/state");
  const last = await getLastHostReclaim().catch(() => null);
  const step = diskStep({ percent, now, last, running: running !== null, deferringSince });

  if (step.kind === "reclaim" || step.kind === "defer") {
    deferringSince ??= now;
    if (step.kind === "reclaim") startReclaim();
    return { disk: null };
  }

  if (!followup || now - followup.at > FOLLOWUP_TTL_MS) {
    followup = { at: now, data: await buildFollowup(last, now) };
  }
  return { disk, followup: followup.data };
}
