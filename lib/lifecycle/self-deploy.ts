// Update markers for a deploy of Vardo itself, so it reports like `vardo update`: the same file, events and emails.

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { isSelfApp } from "@/lib/docker/self-env";
import { logger } from "@/lib/logger";
import { LIFECYCLE_DIR } from "@/lib/paths";
import type { UpdateMarker } from "./classify";

const log = logger.child("lifecycle");

/** The parts of a deploy the marker describes. */
export type SelfDeployRun = {
  deploymentId: string;
  appName: string;
  envIsolated: boolean;
  envType: string;
  startTime: number;
  activeSlot: string | null;
  newSlot: string;
  gitSha?: string | null;
  gitBranch?: string | null;
  repoDir?: string | null;
  slotDir?: string;
  oldStoppedAt?: number;
  healthyAt?: number;
  logLines?: string[];
};

/** True for a deploy that replaces the running console: the `vardo` app's own environment. */
export function isSelfUpdate(run: Pick<SelfDeployRun, "appName" | "envIsolated" | "envType">): boolean {
  return isSelfApp(run.appName) && !run.envIsolated && run.envType !== "local";
}

/** `<package version> (<short sha>)`, as versionLabel() prints it. */
export function targetVersion(packageJson: string | null, gitSha: string | null | undefined): string | undefined {
  let version: string | undefined;
  try {
    version = packageJson ? (JSON.parse(packageJson) as { version?: string }).version : undefined;
  } catch {
    version = undefined;
  }
  const sha = gitSha ? gitSha.slice(0, 7) : "";
  if (version && sha) return `${version} (${sha})`;
  return version ?? (sha || undefined);
}

export type MarkerOutcome =
  | { state: "started" }
  | { state: "updated"; finishedAt: number }
  | { state: "failed"; finishedAt: number; step: string; error: string; rolledBack: boolean };

/** The marker for one self-deploy at one state. Times are epoch ms. */
export function selfDeployMarker(
  run: SelfDeployRun,
  outcome: MarkerOutcome,
  ids: { fromVersion: string; toVersion?: string; fromHost: string },
): UpdateMarker {
  const marker: UpdateMarker = {
    id: run.deploymentId,
    kind: "self-deploy",
    state: outcome.state,
    startedAt: run.startTime,
    fromVersion: ids.fromVersion,
    toVersion: ids.toVersion,
    branch: run.gitBranch ?? undefined,
    fromSlot: run.activeSlot ?? undefined,
    toSlot: run.newSlot,
    fromHost: ids.fromHost,
  };
  if (outcome.state === "updated") {
    marker.finishedAt = outcome.finishedAt;
    // Both slots serve through the cutover, so the console is down only when the old one stopped first.
    marker.healthyAt = run.healthyAt ?? outcome.finishedAt;
    marker.swapStartedAt = run.oldStoppedAt ?? marker.healthyAt;
  }
  if (outcome.state === "failed") {
    marker.finishedAt = outcome.finishedAt;
    marker.step = outcome.step;
    marker.error = outcome.error;
    marker.rolledBack = outcome.rolledBack;
    marker.logTail = (run.logLines ?? []).filter((l) => l.trim()).slice(-20);
  }
  return marker;
}

async function readPackageJson(run: SelfDeployRun): Promise<string | null> {
  for (const dir of [run.slotDir, run.repoDir]) {
    if (!dir) continue;
    try {
      return await readFile(join(dir, "package.json"), "utf-8");
    } catch {
      // Next candidate.
    }
  }
  return null;
}

/** Writes update.json the way install.sh does: whole file, renamed into place. */
export async function writeUpdateMarker(marker: UpdateMarker, dir = LIFECYCLE_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "update.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o644 });
  await rename(tmp, file);
}

/** Records a self-deploy's state and announces what this console should. Never throws. */
export async function recordSelfDeploy(run: SelfDeployRun, outcome: MarkerOutcome): Promise<void> {
  if (!isSelfUpdate(run)) return;
  try {
    const { checkUpdateMarker, selfHost, versionLabel } = await import("./monitor");
    const toVersion = targetVersion(await readPackageJson(run), run.gitSha);
    await writeUpdateMarker(selfDeployMarker(run, outcome, { fromVersion: versionLabel(), toVersion, fromHost: selfHost() }));
    await checkUpdateMarker();
  } catch (err) {
    log.warn(`Couldn't record self-deploy ${run.deploymentId} as ${outcome.state}:`, err);
  }
}
