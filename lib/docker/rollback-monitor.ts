import { db } from "@/lib/db";
import { deployments, apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve } from "path";
import { listContainers, inspectContainer } from "./client";
import { publishEvent, appChannel } from "@/lib/events";
import { recordActivity } from "@/lib/activity";

const execFileAsync = promisify(execFile);
const PROJECTS_DIR = resolve(process.env.VARDO_PROJECTS_DIR || "./.host/projects");
const POLL_INTERVAL_MS = 5000;

/** In-memory set of app IDs currently being monitored. Prevents concurrent monitors. */
const activeMonitors = new Set<string>();

type RollbackMonitorOpts = {
  appId: string;
  appName: string;
  organizationId: string;
  deploymentId: string;
  gracePeriodSeconds: number;
  /** The slot that was just deployed (blue or green) */
  currentSlot: "blue" | "green";
  /** The slot that was active before this deploy (null if first deploy) */
  previousSlot: "blue" | "green" | null;
  /** Environment name for directory resolution */
  envName: string;
};

/**
 * Start a background monitor that watches a freshly deployed container
 * for crashes within the grace period. If a crash is detected, the
 * monitor swaps back to the previous blue-green slot and marks the
 * deployment as rolled_back.
 *
 * This function returns immediately -- monitoring runs in the background.
 * It never throws to the caller.
 */
export function startRollbackMonitor(opts: RollbackMonitorOpts): void {
  // No previous slot means first deploy -- nothing to roll back to
  if (!opts.previousSlot) return;

  // Guard: skip if this app is already being monitored (e.g. rapid re-deploy)
  if (activeMonitors.has(opts.appId)) {
    console.log(
      `[rollback-monitor] Monitor already active for ${opts.appName}, skipping`
    );
    return;
  }

  const {
    appId,
    appName,
    organizationId,
    deploymentId,
    gracePeriodSeconds,
    currentSlot,
    previousSlot,
    envName,
  } = opts;

  activeMonitors.add(appId);
  const deadline = Date.now() + gracePeriodSeconds * 1000;

  // The compose project name that Docker labels containers with
  const slotProjectName = `${appName}-${envName}-${currentSlot}`;

  // Fire-and-forget async loop
  (async () => {
    try {
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        // Check if containers for the current slot are still running
        const crashed = await isContainerCrashed(appName, envName, slotProjectName);

        if (crashed) {
          console.log(
            `[rollback-monitor] Container crashed within grace period for ${appName}, rolling back`
          );

          await performRollback({
            appId,
            appName,
            organizationId,
            deploymentId,
            currentSlot,
            previousSlot,
            envName,
          });
          return; // Done -- rollback performed
        }
      }

      // Grace period passed without crash -- deploy is stable
      console.log(
        `[rollback-monitor] Grace period passed for ${appName} -- deploy is stable`
      );
    } catch (err) {
      // Monitor itself failed -- log but never crash the process
      console.error(
        `[rollback-monitor] Monitor error for ${appName}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      activeMonitors.delete(appId);
    }
  })();
}

/**
 * Check whether any container for the current deploy slot has exited or is restarting.
 * Filters by the compose project name to only check containers belonging to the
 * deployed slot (blue or green), not the previous slot's containers.
 */
async function isContainerCrashed(
  appName: string,
  _envName: string,
  slotProjectName: string,
): Promise<boolean> {
  try {
    const containers = await listContainers(appName);

    // Filter to only containers belonging to the current slot's compose project
    const slotContainers = containers.filter(
      (c) => c.labels["com.docker.compose.project"] === slotProjectName
    );

    if (slotContainers.length === 0) {
      // No containers found for this slot -- treat as crashed
      return true;
    }

    for (const c of slotContainers) {
      const info = await inspectContainer(c.id);
      const status = info.state.status.toLowerCase();
      if (status === "exited" || status === "dead" || status === "restarting") {
        return true;
      }
    }

    return false;
  } catch {
    // If we can't reach Docker, don't trigger a rollback -- that would be
    // dangerous on a transient Docker socket error.
    return false;
  }
}

type PerformRollbackOpts = {
  appId: string;
  appName: string;
  organizationId: string;
  deploymentId: string;
  currentSlot: "blue" | "green";
  previousSlot: "blue" | "green";
  envName: string;
};

async function performRollback(opts: PerformRollbackOpts): Promise<void> {
  const {
    appId,
    appName,
    organizationId,
    deploymentId,
    currentSlot,
    previousSlot,
    envName,
  } = opts;

  const appDir = join(PROJECTS_DIR, appName, envName);

  // Step 1: Tear down the crashing slot
  const crashedSlotDir = join(appDir, currentSlot);
  const crashedProjectName = `${appName}-${envName}-${currentSlot}`;
  const crashedComposePath = join(crashedSlotDir, "docker-compose.yml");

  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", crashedComposePath, "-p", crashedProjectName, "down", "--remove-orphans"],
      { cwd: crashedSlotDir, timeout: 30000 }
    );
  } catch (err) {
    console.error(
      `[rollback-monitor] Failed to tear down crashing slot:`,
      err instanceof Error ? err.message : err
    );
  }

  // Step 2: Bring the previous slot back up
  const prevSlotDir = join(appDir, previousSlot);
  const prevProjectName = `${appName}-${envName}-${previousSlot}`;
  const prevComposePath = join(prevSlotDir, "docker-compose.yml");

  try {
    await execFileAsync(
      "docker",
      ["compose", "-f", prevComposePath, "-p", prevProjectName, "up", "-d"],
      { cwd: prevSlotDir, timeout: 60000 }
    );
  } catch (err) {
    // Previous slot also failed -- just alert, don't recurse
    console.error(
      `[rollback-monitor] Failed to restore previous slot -- manual intervention required:`,
      err instanceof Error ? err.message : err
    );

    await sendRollbackNotification(organizationId, appId, appName, false);
    return;
  }

  // Step 3: Swap active slot marker back
  const { writeFile } = await import("fs/promises");
  await writeFile(join(appDir, ".active-slot"), previousSlot, "utf-8");

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

  // Step 6: Publish event for real-time UI
  publishEvent(appChannel(appId), {
    event: "deploy:rolled_back",
    appId,
    deploymentId,
    message: "Container crashed within grace period, rolled back to previous version",
  }).catch(() => {});

  // Step 7: Record activity
  recordActivity({
    organizationId,
    action: "deployment.rolled_back",
    appId,
    metadata: {
      deploymentId,
      reason: "Container crashed within grace period",
      rolledBackTo: previousSlot,
    },
  }).catch(() => {});

  // Step 8: Notify
  await sendRollbackNotification(organizationId, appId, appName, true);
}

async function sendRollbackNotification(
  organizationId: string,
  appId: string,
  appName: string,
  success: boolean
): Promise<void> {
  try {
    const { notify } = await import("@/lib/notifications/dispatch");
    if (success) {
      notify(organizationId, {
        type: "deploy-failed",
        title: `Auto-rollback: ${appName}`,
        message: `Container crashed after deploy. Rolled back to previous version.`,
        metadata: { projectName: appName, appId },
      });
    } else {
      notify(organizationId, {
        type: "deploy-failed",
        title: `Auto-rollback failed: ${appName}`,
        message: `Container crashed after deploy and rollback to previous version also failed. Manual intervention required.`,
        metadata: { projectName: appName, appId },
      });
    }
  } catch (err) {
    console.error("[rollback-monitor] Notification error:", err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
