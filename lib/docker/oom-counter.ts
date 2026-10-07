// cgroup OOM counters. Docker clears State.OOMKilled on start; the cgroup counter is cumulative.

import { readFile } from "node:fs/promises";

/** Host cgroup root, mounted read-only. The container's own /sys/fs/cgroup always reads zero. */
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

/** Cumulative kills for one cgroup subtree. Null, never zero, when unreadable. */
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

/** Kills across every container on the host, including containers since removed. */
export function readFleetOomKills(root?: string): Promise<number | null> {
  return readOomKills(CONTAINER_SLICE, root);
}

/** Kills inside one container since it was created. */
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
