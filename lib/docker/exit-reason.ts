// ---------------------------------------------------------------------------
// Why a container stopped
//
// apps.status records that a container exited; the exit code alone cannot say
// why. 137 is 128+SIGKILL, which covers both an OOM kill and an ordinary stop
// that outran its timeout. Docker's State.OOMKilled is the only thing that
// separates them, and HostConfig.Memory separates a host kill from a cgroup one.
// ---------------------------------------------------------------------------

import type { ContainerInfo } from "./client";

/** Exit code embedded in a list-API status string, e.g. "Exited (137) 2 days ago". */
export function parseExitCode(status: string): number | null {
  const m = /^Exited \((\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

/**
 * "oom-host" is the kernel picking a victim because the machine ran out —
 * capacity. "oom-limit" is the container hitting its own cgroup cap — a limit
 * set too low. They call for different responses and must not be merged.
 */
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

/**
 * How long an OOM kill outlives the container coming back up. A crash loop is
 * running on the ticks between restarts, and the kill is still the answer.
 */
export const OOM_STICKY_MS = 10 * 60_000;

/**
 * Whether a stored kill still explains an app that is running again. Only the
 * same container restarting in place — a redeploy is a new container and has
 * answered for itself.
 */
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

/**
 * Why one container stopped, or null for a clean exit. A signal exit is not a
 * fault — a stop that outran its grace period lands here and reads as routine.
 */
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

/**
 * Containers worth inspecting for a reason. A clean exit needs no explanation,
 * and a running container has not ended — inspecting either only costs a call.
 */
export function exitCandidates(containers: ContainerInfo[]): ContainerInfo[] {
  return containers.filter((c) => {
    if (c.state === "running") return false;
    if (c.state === "restarting" || c.state === "dead") return true;
    return (parseExitCode(c.status) ?? 0) !== 0;
  });
}
