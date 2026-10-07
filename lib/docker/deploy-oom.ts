// Reports OOM kills that land inside a deploy window, which otherwise read as routine slot teardown.

import { logger } from "@/lib/logger";
import { listAllContainers, inspectContainer } from "./client";
import { exitReasonFor, isOomKill, type ExitReason, type TerminalState } from "./exit-reason";

const log = logger.child("deploy-oom");

/** Who the kill is reported against. */
export type OomSubject = {
  organizationId: string;
  appId: string;
  appName: string;
};

/** OOM kills among these containers that landed inside the window. */
export function oomKillsInWindow(
  states: TerminalState[],
  since: Date,
  now: Date,
): ExitReason[] {
  return states.flatMap((state) => {
    const reason = exitReasonFor(state, now);
    if (!reason || !isOomKill(reason)) return [];
    return Date.parse(reason.at) >= since.getTime() ? [reason] : [];
  });
}

/** Terminal state of every stopped container in a compose project. */
async function terminalStates(projectName: string): Promise<TerminalState[]> {
  const containers = (await listAllContainers()).filter(
    (c) => c.labels["com.docker.compose.project"] === projectName && c.state !== "running",
  );

  const states: TerminalState[] = [];
  for (const container of containers) {
    try {
      const info = await inspectContainer(container.id);
      states.push({
        containerId: container.id,
        containerName: container.name,
        oomKilled: info.state.oomKilled,
        exitCode: info.state.exitCode,
        memoryLimit: info.memoryBytes,
        finishedAt: info.state.finishedAt,
      });
    } catch {
      // Gone between list and inspect.
    }
  }
  return states;
}

/** Report any OOM kill among a compose project's containers since `since`. Never throws. */
export async function reportOomDuringDeploy(
  subject: OomSubject,
  projectName: string,
  since: Date,
  deployLog: (line: string) => void,
  now: Date = new Date(),
): Promise<void> {
  let kills: ExitReason[];
  try {
    kills = oomKillsInWindow(await terminalStates(projectName), since, now);
  } catch (err) {
    log.warn(`Could not check ${projectName} for OOM kills:`, (err as Error).message);
    return;
  }
  if (kills.length === 0) return;

  const { emit } = await import("@/lib/notifications/dispatch").catch(() => ({ emit: null }));

  for (const reason of kills) {
    const host = reason.kind === "oom-host";
    deployLog(
      `[deploy] ${reason.containerName} was killed for memory during this deploy — the kernel chose the slot on its way out, and could as easily have chosen the new one`,
    );
    log.error(`OOM kill during deploy: ${reason.containerName} (app ${subject.appName}, ${reason.kind})`);

    emit?.(subject.organizationId, {
      type: "app.oom-killed",
      title: host
        ? `Killed for host memory during deploy: ${subject.appName}`
        : `Killed at memory limit during deploy: ${subject.appName}`,
      message: host
        ? `${subject.appName} deployed successfully, but the host ran out of memory during the cutover and the kernel killed ${reason.containerName}, which has no memory limit of its own. It was the slot being retired this time; the new slot and every other uncapped container were equally available. Free memory on the host, or give this app a limit.`
        : `${subject.appName} deployed successfully, but ${reason.containerName} was killed at its own memory limit during the cutover. Raise the limit, or find out what is using more than it was given.`,
      appId: subject.appId,
      appName: subject.appName,
      containerName: reason.containerName,
      containerId: reason.containerId,
      kind: host ? "oom-host" : "oom-limit",
      exitCode: reason.exitCode,
      at: reason.at,
    });
  }
}
