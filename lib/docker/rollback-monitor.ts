// ---------------------------------------------------------------------------
// Auto-rollback action.
//
// The grace period itself is reconciled by the deploy sweeper against live
// state; this module only inspects a slot and performs the swap back.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { appEnvDir } from "@/lib/paths";
import { rm, symlink, rename } from "fs/promises";
import { listContainers } from "./client";
import { slotComposeFiles } from "./compose";
import { slotScopeArgs } from "./slot-partition";
import { readSlotPartition } from "./shared-project";
import { demoteStandbyRestart, restoreSlotRestart } from "./restart-policy";
import { COMPOSE_DOWN_TIMEOUT, COMPOSE_UP_TIMEOUT, COMPOSE_QUERY_TIMEOUT } from "./constants";
import { addEvent, addDeployLog } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { logger } from "@/lib/logger";

const log = logger.child("rollback-monitor");

const execFileAsync = promisify(execFile);

/**
 * Container ids belonging to a compose project. `all` includes stopped ones.
 * Returns null when Docker could not be reached — never an empty list, so a
 * socket blip can't read as "the slot is gone".
 */
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
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch (err) {
    log.warn(`Could not list containers for ${projectName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Whether a slot has stopped serving. Null when Docker is unreachable, which
 * callers must treat as "unknown" rather than as a crash.
 */
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
};

/**
 * Swap a crashed slot back to its predecessor and mark the deployment
 * rolled_back. Returns false when the previous slot could not be restored — in
 * that case the crashed slot is put back and no bookkeeping is written.
 */
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

  const appDir = appEnvDir(appName, envName);

  const crashedSlotDir = join(appDir, currentSlot);
  const crashedProjectName = `${appName}-${envName}-${currentSlot}`;
  const crashedComposeFileArgs = await slotComposeFiles(crashedSlotDir);

  const prevSlotDir = join(appDir, previousSlot);
  const prevProjectName = `${appName}-${envName}-${previousSlot}`;
  const prevComposeFileArgs = await slotComposeFiles(prevSlotDir);
  const prevPartition = await readSlotPartition(prevSlotDir);

  // Step 1: Stop the crashing slot so its restart policy can't reclaim a host
  // port while the previous slot binds it. Reversible — the containers stay.
  try {
    await execFileAsync(
      "docker",
      ["compose", ...crashedComposeFileArgs, "-p", crashedProjectName, "stop"],
      { cwd: crashedSlotDir, timeout: COMPOSE_DOWN_TIMEOUT },
    );
  } catch (err) {
    log.warn("Could not stop the crashing slot:", err instanceof Error ? err.message : err);
  }

  // Step 2: Bring the previous slot back up, naming the rotating set only —
  // an unqualified `up` would start a second copy of the shared services here.
  try {
    await execFileAsync(
      "docker",
      [
        "compose", ...prevComposeFileArgs, "-p", prevProjectName,
        "up", "-d", "--no-recreate", "--pull", "never",
        ...(prevPartition ? slotScopeArgs(prevPartition) : []),
      ],
      { cwd: prevSlotDir, timeout: COMPOSE_UP_TIMEOUT },
    );
    await restoreSlotRestart(prevComposeFileArgs, prevProjectName, prevSlotDir);
  } catch (err) {
    log.error(
      "Failed to restore previous slot — putting the crashed slot back:",
      err instanceof Error ? err.message : err,
    );

    // Nothing is serving right now. Undo step 1 rather than leave the app dark.
    await execFileAsync(
      "docker",
      [
        "compose", ...crashedComposeFileArgs, "-p", crashedProjectName,
        "up", "-d", "--no-recreate", "--pull", "never",
      ],
      { cwd: crashedSlotDir, timeout: COMPOSE_UP_TIMEOUT },
    ).catch(() => {});

    await sendRollbackNotification(organizationId, appId, appName, false);
    return false;
  }

  // Step 3: Atomic symlink swap back to the previous slot
  const currentSymlinkPath = join(appDir, "current");
  const tmpSymlinkPath = join(appDir, "current.tmp");
  try {
    await rm(tmpSymlinkPath, { force: true });
    await symlink(previousSlot, tmpSymlinkPath, "dir");
    await rename(tmpSymlinkPath, currentSymlinkPath);
    log.info(`[rollback] Updated 'current' symlink -> ${previousSlot}`);
  } catch (err) {
    log.warn(`[rollback] Failed to create 'current' symlink: ${err instanceof Error ? err.message : err}`);
  }

  // Step 3a: The crashed slot is the standby now, so it must not come back on a
  // daemon restart.
  await demoteStandbyRestart(crashedComposeFileArgs, crashedProjectName, crashedSlotDir);

  // Step 3b: Update container name in DB (for logs/UI — not routing).
  // Traefik discovers the restored containers via their Docker labels automatically.
  try {
    // vardo.project is the app name, never the slot's compose project, so the
    // restored slot is picked out by com.docker.compose.project.
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

  // Step 4: Update deployment status to rolled_back
  await db
    .update(deployments)
    .set({ status: "rolled_back", finishedAt: new Date() })
    .where(eq(deployments.id, deploymentId));

  // Step 5: Set app status back to active (previous slot is running)
  await db
    .update(apps)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(apps.id, appId));

  // Step 6: Write to deploy stream + org event stream for real-time UI
  addDeployLog(deploymentId, {
    line: "Containers stopped within grace period, rolled back to previous version",
    stage: "rollback",
    status: "failed",
  }).catch(() => {});

  addEvent(organizationId, {
    type: "deploy.status",
    title: "Deploy rolled back",
    message: "Containers stopped within grace period, rolled back to previous version",
    appId,
    deploymentId,
    status: "error",
    success: false,
  }).catch(() => {});

  // Step 7: Record activity
  recordActivity({
    organizationId,
    action: "deployment.rolled_back",
    appId,
    metadata: {
      deploymentId,
      reason: "Containers stopped within grace period",
      rolledBackTo: previousSlot,
    },
  }).catch(() => {});

  // Step 8: Notify
  await sendRollbackNotification(organizationId, appId, appName, true);
  return true;
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
