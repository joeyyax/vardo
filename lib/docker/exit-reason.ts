// Why a container stopped. Exit 137 alone can't tell an OOM kill from a slow stop; State.OOMKilled can.

import type { ContainerInfo } from "./client";

/** Exit code embedded in a list-API status string, e.g. "Exited (137) 2 days ago". */
export function parseExitCode(status: string): number | null {
  const m = /^Exited \((\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

/** "oom-host": the machine ran out. "oom-limit": the container hit its own cap. Keep them distinct. */
export type ExitReasonKind = "oom-host" | "oom-limit" | "signal" | "failed";

export type ExitReason = {
  kind: ExitReasonKind;
  exitCode: number;
  /** Signal name behind a 128+n exit, e.g. "SIGKILL". */
  signal?: string;
  containerId: string;
  containerName: string;
  /** ISO timestamp the container finished. */
  at: string;
};

/** How long an OOM kill stays the reason after the container comes back up. */
export const OOM_STICKY_MS = 10 * 60_000;

/** Whether a stored OOM kill still explains a running app. Only the same container restarting in place. */
export function reasonSurvivesRestart(
  prev: ExitReason | null | undefined,
  running: { id: string; startedAt: Date | null } | null,
  now: Date,
): ExitReason | null {
  if (!prev || !isOomKill(prev) || !running?.startedAt) return null;
  if (running.id !== prev.containerId) return null;
  return now.getTime() - running.startedAt.getTime() < OOM_STICKY_MS ? prev : null;
}

/** Exit codes Docker reports as 128 + signal number. */
const SIGNALS: Record<number, string> = {
  130: "SIGINT",
  137: "SIGKILL",
  139: "SIGSEGV",
  143: "SIGTERM",
};

/** A Docker date that was never set. */
const NEVER = "0001-01-01T00:00:00Z";

export type TerminalState = {
  containerId: string;
  containerName: string;
  oomKilled: boolean;
  exitCode: number;
  /** Container's cgroup memory limit in bytes. 0 means none was set. */
  memoryLimit: number;
  finishedAt: string;
};

/** Why one container stopped, or null for a clean exit. Signal exits read as routine. */
export function exitReasonFor(c: TerminalState, now: Date): ExitReason | null {
  if (!c.oomKilled && c.exitCode === 0) return null;

  const at =
    c.finishedAt && c.finishedAt !== NEVER && !isNaN(Date.parse(c.finishedAt))
      ? new Date(c.finishedAt).toISOString()
      : now.toISOString();

  if (c.oomKilled) {
    return {
      kind: c.memoryLimit > 0 ? "oom-limit" : "oom-host",
      exitCode: c.exitCode,
      containerId: c.containerId,
      containerName: c.containerName,
      at,
    };
  }

  const signal = SIGNALS[c.exitCode];
  return {
    kind: signal ? "signal" : "failed",
    exitCode: c.exitCode,
    ...(signal ? { signal } : {}),
    containerId: c.containerId,
    containerName: c.containerName,
    at,
  };
}

export function isOomKill(reason: ExitReason | null | undefined): boolean {
  return reason?.kind === "oom-host" || reason?.kind === "oom-limit";
}

const RANK: Record<ExitReasonKind, number> = {
  "oom-host": 0,
  "oom-limit": 0,
  failed: 1,
  signal: 2,
};

/** The reason worth reporting across an app's containers: an OOM kill first, then the most recent. */
export function worstExitReason(reasons: ExitReason[]): ExitReason | null {
  return reasons.reduce<ExitReason | null>((worst, r) => {
    if (!worst) return r;
    if (RANK[r.kind] !== RANK[worst.kind]) return RANK[r.kind] < RANK[worst.kind] ? r : worst;
    return Date.parse(r.at) > Date.parse(worst.at) ? r : worst;
  }, null);
}

/** Stopped containers with a non-zero exit, plus restarting or dead ones. */
export function exitCandidates(containers: ContainerInfo[]): ContainerInfo[] {
  return containers.filter((c) => {
    if (c.state === "running") return false;
    if (c.state === "restarting" || c.state === "dead") return true;
    return (parseExitCode(c.status) ?? 0) !== 0;
  });
}
