// Auto-rollback: swaps a crashed slot back to its predecessor as its own deployment row.

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { join } from "path";
import { nanoid } from "nanoid";
import { appEnvDir } from "@/lib/paths";
import { rm, symlink, rename } from "fs/promises";
import { listContainers } from "./client";
import { slotComposeFiles } from "./compose";
import { slotScopeArgs } from "./slot-partition";
import { readSlotPartition } from "./shared-project";
import { demoteStandbyRestart, restoreSlotRestart } from "./restart-policy";
import { COMPOSE_DOWN_TIMEOUT, COMPOSE_UP_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "./constants";
import { addEvent } from "@/lib/stream/producer";
import { createDeployLogger } from "./deploy-logger";
import type { RollbackStage, DeployStatus } from "./deploy-logger";
import { recordActivity } from "@/lib/activity";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

const log = logger.child("rollback-monitor");


/** Container ids in a compose project (`all` includes stopped). Null when Docker is unreachable, never empty. */
export async function slotContainerIds(
  projectName: string,
  all: boolean,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        ...(all ? ["-a"] : []),
        "-q",
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
      ],
      { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch (err) {
    log.warn(`Could not list containers for ${projectName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Whether a slot has stopped serving. Null means unknown, not a crash. */
export async function slotIsDown(projectName: string): Promise<boolean | null> {
  const ids = await slotContainerIds(projectName, false);
  if (ids === null) return null;
  return ids.length === 0;
}

export type PerformRollbackOpts = {
  appId: string;
  appName: string;
  organizationId: string;
  deploymentId: string;
  /** The slot that crashed. */
  currentSlot: "blue" | "green";
  /** The slot to restore. */
  previousSlot: "blue" | "green";
  envName: string;
  /** Environment the crashed deploy belongs to, carried onto the rollback row. */
  environmentId?: string | null;
};

/** Swap a crashed slot back to its predecessor. False if the restore failed and the crashed slot was put back. */
export async function performRollback(opts: PerformRollbackOpts): Promise<boolean> {
  const {
    appId,
    appName,
    organizationId,
    deploymentId,
    currentSlot,
    previousSlot,
    envName,
  } = opts;

  const startedAt = Date.now();
  const rollbackId = nanoid();
  const logLines: string[] = [];
  const streamLogger = createDeployLogger(rollbackId);

  // Serialized so a slow write can't overwrite a later one.
  let logFlush: Promise<unknown> = Promise.resolve();

  function flushLog() {
    const snapshot = logLines.join("\n");
    logFlush = logFlush
      .then(() =>
        db.update(deployments).set({ log: snapshot }).where(eq(deployments.id, rollbackId)),
      )
      .catch(() => {});
  }

  function rollbackLog(line: string) {
    logLines.push(streamLogger.log(line));
  }

  function stage(s: RollbackStage, status: DeployStatus) {
    streamLogger.stage(s, status);
    flushLog();
  }

  /** Close the rollback row and hand the app status back. */
  async function finish(
    status: "success" | "failed",
    appStatus: "active" | "error",
  ): Promise<void> {
    await logFlush;
    await db
      .update(deployments)
      .set({
        status,
        log: logLines.join("\n"),
        durationMs: Date.now() - startedAt,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, rollbackId));

    // Guarded so a deploy that claimed the app meanwhile keeps it.
    await db
      .update(apps)
      .set(statusChange(appStatus))
      .where(and(eq(apps.id, appId), eq(apps.status, "deploying")));

    await streamLogger.flush();
  }

  try {
    // Commit the restored slot is running.
    const restored = await db.query.deployments
      .findFirst({
        where: and(
          eq(deployments.appId, appId),
          eq(deployments.status, "success"),
          eq(deployments.slot, previousSlot),
        ),
        orderBy: [desc(deployments.startedAt)],
        columns: { gitSha: true, gitMessage: true },
      })
      .catch(() => null);

    await db.insert(deployments).values({
      id: rollbackId,
      appId,
      status: "running",
      trigger: "rollback",
      rollbackFromId: deploymentId,
      slot: previousSlot,
      gitSha: restored?.gitSha ?? null,
      gitMessage: restored?.gitMessage ?? null,
      environmentId: opts.environmentId ?? null,
      startedAt: new Date(startedAt),
    });

    // Owns apps.status like a deploy, so the stuck-deploy sweep recovers it if the process dies.
    await db
      .update(apps)
      .set(statusChange("deploying"))
      .where(eq(apps.id, appId));

    rollbackLog(`[rollback] ${appName} stopped inside its grace period — restoring ${previousSlot}`);

    const appDir = appEnvDir(appName, envName);

    const crashedSlotDir = join(appDir, currentSlot);
    const crashedProjectName = `${appName}-${envName}-${currentSlot}`;
    const crashedComposeFileArgs = await slotComposeFiles(crashedSlotDir);

    const prevSlotDir = join(appDir, previousSlot);
    const prevProjectName = `${appName}-${envName}-${previousSlot}`;
    const prevComposeFileArgs = await slotComposeFiles(prevSlotDir);
    const prevPartition = await readSlotPartition(prevSlotDir);

    // Stop (not down) the crashed slot so its restart policy can't reclaim a host port.
    stage("stop", "running");
    try {
      await execFileAsync(
        "docker",
        ["compose", ...crashedComposeFileArgs, "-p", crashedProjectName, "stop"],
        { env: dockerEnv(), cwd: crashedSlotDir, timeout: COMPOSE_DOWN_TIMEOUT },
      );
      rollbackLog(`[rollback] Stopped the crashed ${currentSlot} slot`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Could not stop the crashing slot:", message);
      rollbackLog(`[rollback] Could not stop the crashed ${currentSlot} slot: ${message}`);
    }
    stage("stop", "success");

    // Rotating set only; an unqualified `up` would start a second copy of the shared services.
    stage("restore", "running");
    try {
      await execFileAsync(
        "docker",
        [
          "compose", ...prevComposeFileArgs, "-p", prevProjectName,
          "up", "-d", "--no-recreate", "--pull", "never",
          ...(prevPartition ? slotScopeArgs(prevPartition) : []),
        ],
        { env: dockerEnv(), cwd: prevSlotDir, timeout: COMPOSE_UP_TIMEOUT },
      );
      await restoreSlotRestart(prevComposeFileArgs, prevProjectName, prevSlotDir);
      rollbackLog(`[rollback] Restored the ${previousSlot} slot`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to restore previous slot — putting the crashed slot back:", message);
      rollbackLog(`[rollback] ERROR: could not restore the ${previousSlot} slot: ${message}`);

      // Nothing is serving; put the crashed slot back.
      await execFileAsync(
        "docker",
        [
          "compose", ...crashedComposeFileArgs, "-p", crashedProjectName,
          "up", "-d", "--no-recreate", "--pull", "never",
        ],
        { env: dockerEnv(), cwd: crashedSlotDir, timeout: COMPOSE_UP_TIMEOUT },
      ).catch(() => {});
      rollbackLog(`[rollback] Put the ${currentSlot} slot back rather than leave the app dark`);

      stage("restore", "failed");
      await finish("failed", "error");
      await sendRollbackNotification(organizationId, appId, appName, false);
      return false;
    }
    stage("restore", "success");

    // Atomic symlink swap.
    stage("route", "running");
    const currentSymlinkPath = join(appDir, "current");
    const tmpSymlinkPath = join(appDir, "current.tmp");
    try {
      await rm(tmpSymlinkPath, { force: true });
      await symlink(previousSlot, tmpSymlinkPath, "dir");
      await rename(tmpSymlinkPath, currentSymlinkPath);
      log.info(`[rollback] Updated 'current' symlink -> ${previousSlot}`);
      rollbackLog(`[rollback] Pointed 'current' at ${previousSlot}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[rollback] Failed to create 'current' symlink: ${message}`);
      rollbackLog(`[rollback] Could not point 'current' at ${previousSlot}: ${message}`);
    }

    // The crashed slot must not come back on a daemon restart.
    await demoteStandbyRestart(crashedComposeFileArgs, crashedProjectName, crashedSlotDir);

    // Container name is for logs and UI only.
    try {
      const envContainers = await listContainers({ id: appId, name: appName }, envName);
      const containers = envContainers.filter(
        (c) => c.labels["com.docker.compose.project"] === prevProjectName,
      );
      if (containers.length > 0) {
        await db
          .update(apps)
          .set({ containerName: containers[0].name, updatedAt: new Date() })
          .where(eq(apps.id, appId));
      }
    } catch (err) {
      log.warn(`[rollback] Failed to update container name: ${err instanceof Error ? err.message : err}`);
    }
    stage("route", "success");

    stage("verify", "running");
    const restoredIds = await slotContainerIds(prevProjectName, false);
    if (restoredIds !== null && restoredIds.length === 0) {
      rollbackLog(`[rollback] ERROR: the ${previousSlot} slot is not running after the swap`);
      stage("verify", "failed");

      // The deploy was rolled back; the restore didn't hold.
      await db
        .update(deployments)
        .set({ status: "rolled_back" })
        .where(eq(deployments.id, deploymentId));
      await finish("failed", "error");
      await sendRollbackNotification(
        organizationId,
        appId,
        appName,
        false,
        `Rolled back to ${previousSlot}, but that slot is not running. Manual intervention required.`,
      );
      return false;
    }
    if (restoredIds === null) {
      rollbackLog("[rollback] Docker did not answer — treating the restored slot as serving");
    }
    stage("verify", "success");

    // Only the rescued deploy's status changes.
    await db
      .update(deployments)
      .set({ status: "rolled_back" })
      .where(eq(deployments.id, deploymentId));

    rollbackLog(`[rollback] ${appName} is serving from ${previousSlot} again`);
    stage("done", "success");
    await finish("success", "active");

    addEvent(organizationId, {
      type: "deploy.status",
      title: "Deploy rolled back",
      message: "Containers stopped within grace period, rolled back to previous version",
      appId,
      deploymentId: rollbackId,
      status: "error",
      success: false,
    }).catch(() => {});

    recordActivity({
      organizationId,
      action: "deployment.rolled_back",
      appId,
      metadata: {
        deploymentId,
        rollbackDeploymentId: rollbackId,
        reason: "Containers stopped within grace period",
        rolledBackTo: previousSlot,
      },
    }).catch(() => {});

    await sendRollbackNotification(organizationId, appId, appName, true);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Rollback failed unexpectedly:", message);
    rollbackLog(`[rollback] ERROR: ${message}`);
    stage("done", "failed");
    await finish("failed", "error");
    await sendRollbackNotification(
      organizationId,
      appId,
      appName,
      false,
      `Rollback failed: ${message}. Manual intervention required.`,
    );
    return false;
  }
}

export async function sendRollbackNotification(
  organizationId: string,
  appId: string,
  appName: string,
  success: boolean,
  message?: string,
): Promise<void> {
  try {
    const { emit } = await import("@/lib/notifications/dispatch");
    emit(organizationId, {
      type: "deploy.rollback",
      title: success
        ? `Auto-rollback: ${appName}`
        : `Auto-rollback failed: ${appName}`,
      message:
        message ??
        (success
          ? `Containers stopped after deploy. Rolled back to previous version.`
          : `Containers stopped after deploy and the previous version could not be restored. Manual intervention required.`),
      projectName: appName,
      appId,
      rollbackSuccess: success,
    });
  } catch (err) {
    log.error("Notification error:", err);
  }
}
