import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { readlink, rm, symlink, rename } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { nanoid } from "nanoid";
import { appEnvDir } from "@/lib/paths";
import { slotComposeFiles } from "./compose";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import {
  NETWORK_NAME,
  COMPOSE_UP_TIMEOUT,
  COMPOSE_DOWN_TIMEOUT,
  COMPOSE_QUERY_TIMEOUT,
  INSTANT_ROLLBACK_HEALTH_TIMEOUT,
  INSTANT_ROLLBACK_POLL_INTERVAL,
} from "./constants";
import type { ResolvedEnv } from "./resolve-env";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type InstantRollbackOpts = {
  appId: string;
  appName: string;
  organizationId: string;
  userId: string;
  env: ResolvedEnv;
};

export type InstantRollbackResult = {
  success: boolean;
  deploymentId: string;
  fromSlot: string;
  toSlot: string;
  durationMs: number;
  error?: string;
};

export async function checkStandbyAvailable(
  appName: string,
  env: ResolvedEnv,
): Promise<{
  activeSlot: string;
  standbySlot: string | null;
  standbyAvailable: boolean;
  standbyServiceCount: number;
}> {
  if (env.type === "local") {
    return { activeSlot: "local", standbySlot: null, standbyAvailable: false, standbyServiceCount: 0 };
  }

  const appDir = appEnvDir(appName, env.name);
  let activeSlot: string;
  try {
    activeSlot = (await readlink(join(appDir, "current"))).trim();
  } catch {
    activeSlot = "blue";
  }

  const standbySlot = activeSlot === "blue" ? "green" : "blue";
  const standbyDir = join(appDir, standbySlot);
  const standbyProjectName = `${appName}-${env.name}-${standbySlot}`;

  let standbyAvailable = false;
  let standbyServiceCount = 0;
  try {
    const composeFileArgs = await slotComposeFiles(standbyDir);
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", standbyProjectName, "ps", "-a", "--format", "json"],
      { cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const containers = stdout.trim().split("\n").filter(Boolean);
    standbyServiceCount = containers.length;
    standbyAvailable = containers.length > 0;
  } catch {
    // No containers on standby slot
  }

  return { activeSlot, standbySlot, standbyAvailable, standbyServiceCount };
}

export async function performInstantRollback(
  opts: InstantRollbackOpts,
): Promise<InstantRollbackResult> {
  const { appId, appName, organizationId, userId, env } = opts;
  const startTime = Date.now();
  const appDir = appEnvDir(appName, env.name);

  let activeSlot: string;
  try {
    activeSlot = (await readlink(join(appDir, "current"))).trim();
  } catch {
    return { success: false, deploymentId: "", fromSlot: "", toSlot: "", durationMs: 0, error: "No active deployment" };
  }

  const standbySlot = activeSlot === "blue" ? "green" : "blue";
  const standbyDir = join(appDir, standbySlot);
  const standbyProjectName = `${appName}-${env.name}-${standbySlot}`;
  const activeDir = join(appDir, activeSlot);
  const activeProjectName = `${appName}-${env.name}-${activeSlot}`;

  const standbyComposeFileArgs = await slotComposeFiles(standbyDir);
  const activeComposeFileArgs = await slotComposeFiles(activeDir);

  // Verify standby has containers
  let standbyHasContainers = false;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", ...standbyComposeFileArgs, "-p", standbyProjectName, "ps", "-a", "--format", "json"],
      { cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    standbyHasContainers = stdout.trim().split("\n").filter(Boolean).length > 0;
  } catch { /* no containers */ }

  if (!standbyHasContainers) {
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "No standby containers available — use standard rollback",
    };
  }

  // Step 1: Start standby slot — use `up -d --no-recreate --pull never` for
  // resilience (handles missing containers, reconnects networks) over bare `start`.
  try {
    await execFileAsync(
      "docker",
      [
        "compose", ...standbyComposeFileArgs, "-p", standbyProjectName,
        "up", "-d", "--no-recreate", "--pull", "never",
      ],
      { cwd: standbyDir, timeout: COMPOSE_UP_TIMEOUT },
    );
  } catch (err) {
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "Failed to start standby slot",
    };
  }

  // Step 2: Health check — wait for containers to be running
  const healthDeadline = Date.now() + INSTANT_ROLLBACK_HEALTH_TIMEOUT;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", ...standbyComposeFileArgs, "-p", standbyProjectName, "ps", "--format", "json"],
        { cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
      );
      const containers = stdout.trim().split("\n").filter(Boolean);
      if (containers.length > 0) {
        const allRunning = containers.every((line) => {
          try { return (JSON.parse(line).State || "").toLowerCase() === "running"; }
          catch { return false; }
        });
        if (allRunning) { healthy = true; break; }
      }
    } catch { /* retry */ }
    await sleep(INSTANT_ROLLBACK_POLL_INTERVAL);
  }

  if (!healthy) {
    await execFileAsync(
      "docker",
      ["compose", ...standbyComposeFileArgs, "-p", standbyProjectName, "stop"],
      { cwd: standbyDir, timeout: COMPOSE_DOWN_TIMEOUT },
    ).catch(() => {});
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "Standby containers failed to start — use standard rollback",
    };
  }

  // Step 3: Remove active slot from Traefik's routing pool before stopping,
  // so in-flight requests don't hit a shutting-down container.
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "ps", "-q"],
      { cwd: activeDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    for (const id of stdout.trim().split("\n").filter(Boolean)) {
      await execFileAsync(
        "docker",
        ["network", "disconnect", "-f", NETWORK_NAME, id],
        { timeout: COMPOSE_QUERY_TIMEOUT },
      ).catch(() => {});
    }
  } catch { /* best-effort */ }

  // Step 4: Stop the active slot
  try {
    await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "stop"],
      { cwd: activeDir, timeout: COMPOSE_DOWN_TIMEOUT },
    );
  } catch { /* best-effort — standby is already serving */ }

  // Step 5: Flip the current symlink
  const currentSymlinkPath = join(appDir, "current");
  const tmpSymlinkPath = join(appDir, "current.tmp");
  try {
    await rm(tmpSymlinkPath, { force: true });
    await symlink(standbySlot, tmpSymlinkPath, "dir");
    await rename(tmpSymlinkPath, currentSymlinkPath);
  } catch {
    // Symlink swap failed — standby is serving, this is just bookkeeping
  }

  // Step 6: Update container name in DB
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", ...standbyComposeFileArgs, "-p", standbyProjectName, "ps", "--format", "json"],
      { cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const firstContainer = stdout.trim().split("\n").filter(Boolean)[0];
    if (firstContainer) {
      const parsed = JSON.parse(firstContainer);
      const containerName = parsed.Name || `${standbyProjectName}-${parsed.Service}-1`;
      await db
        .update(apps)
        .set({ containerName, status: "active", updatedAt: new Date() })
        .where(eq(apps.id, appId));
    }
  } catch { /* best-effort */ }

  // Step 7: Create deployment record
  const durationMs = Date.now() - startTime;
  const deploymentId = nanoid();

  const standbyDeploy = await db.query.deployments.findFirst({
    where: and(
      eq(deployments.appId, appId),
      eq(deployments.status, "success"),
      eq(deployments.slot, standbySlot),
    ),
    orderBy: [desc(deployments.startedAt)],
    columns: { id: true, gitSha: true, gitMessage: true, environmentId: true },
  });

  await db.insert(deployments).values({
    id: deploymentId,
    appId,
    status: "success",
    trigger: "rollback",
    triggeredBy: userId,
    gitSha: standbyDeploy?.gitSha ?? null,
    gitMessage: standbyDeploy?.gitMessage ?? null,
    log: `[rollback] Instant rollback: ${activeSlot} → ${standbySlot} (${durationMs}ms)`,
    durationMs,
    slot: standbySlot,
    rollbackFromId: standbyDeploy?.id ?? null,
    environmentId: standbyDeploy?.environmentId ?? env.id,
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  addEvent(organizationId, {
    type: "deploy.status",
    title: "Instant rollback",
    message: `Rolled back to ${standbySlot} slot in ${durationMs}ms`,
    appId,
    deploymentId,
    status: "active",
    success: true,
    durationMs,
  }).catch(() => {});

  recordActivity({
    organizationId,
    action: "deployment.instant_rollback",
    appId,
    userId,
    metadata: { deploymentId, fromSlot: activeSlot, toSlot: standbySlot, durationMs },
  }).catch(() => {});

  return { success: true, deploymentId, fromSlot: activeSlot, toSlot: standbySlot, durationMs };
}
