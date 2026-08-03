// ---------------------------------------------------------------------------
// cgroup OOM counters
//
// Docker clears State.OOMKilled when a container starts, so every kill on a
// container that came back is invisible — the reconciler can only read the flag
// on one that is still stopped. The cgroup counter is cumulative and never
// cleared, which makes it the only complete signal.
//
// On this host there is no second source: inside an LXC the kernel ring buffer
// belongs to the Proxmox host, so dmesg and journalctl -k carry no OOM lines at
// all. Docker's stats API reports memory.stat, which does not carry the counter.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";

/**
 * Host cgroup root, mounted read-only. Matches the /host-proc mount the GPU
 * collector reads. The container's own /sys/fs/cgroup is namespaced to itself
 * and always reads zero, so it cannot stand in for this.
 */
export const HOST_CGROUP = process.env.HOST_CGROUP_PATH || "/host-cgroup";

/** Where the systemd cgroup driver puts container scopes. */
export const CONTAINER_SLICE = "system.slice";

/** cgroup path for one container's scope, relative to the cgroup root. */
export function containerScope(containerId: string): string {
  return `${CONTAINER_SLICE}/docker-${containerId}.scope`;
}

/** `oom_kill` out of a memory.events file, or null when the line is absent. */
export function parseOomKill(content: string): number | null {
  const m = /^oom_kill (\d+)$/m.exec(content);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cumulative kills for one cgroup and everything under it. Null when the mount
 * is absent or the cgroup is gone — a host Vardo cannot read must not report
 * zero kills, which reads as "all clear".
 */
export async function readOomKills(
  cgroupPath: string,
  root: string = HOST_CGROUP,
): Promise<number | null> {
  try {
    return parseOomKill(await readFile(`${root}/${cgroupPath}/memory.events`, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Kills across every container on the host. memory.events counts the whole
 * subtree, so the slice total holds kills whose own cgroup died with its
 * container — the 164-of-165 the per-container files can no longer account for.
 */
export function readFleetOomKills(root?: string): Promise<number | null> {
  return readOomKills(CONTAINER_SLICE, root);
}

/**
 * Kills inside one container since it started. The scope cgroup is created with
 * the container, so this counts the current life only and resets on recreate.
 */
export function readContainerOomKills(
  containerId: string,
  root?: string,
): Promise<number | null> {
  return readOomKills(containerScope(containerId), root);
}

/** Whether the host cgroup root is mounted at all. */
export async function oomCountersReadable(root?: string): Promise<boolean> {
  return (await readFleetOomKills(root)) !== null;
}
