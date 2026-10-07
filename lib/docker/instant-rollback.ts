import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { rm, symlink, rename } from "fs/promises";
import { join } from "path";
import { nanoid } from "nanoid";
import { appEnvDir } from "@/lib/paths";
import { slotComposeFiles } from "./compose";
import { detectActiveSlot } from "./slots";
import { slotScopeArgs } from "./slot-partition";
import { readSlotPartition } from "./shared-project";
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
import { demoteStandbyRestart, restoreSlotRestart } from "./restart-policy";
import { clearCutoverPin } from "./traefik-cutover";
import { execFileAsync } from "@/lib/utils/exec";
import { claimAppForOperation } from "./deploy-cancel";

/** Outlasts every step below, so a crashed rollback frees the app on its own. */
const ROLLBACK_CLAIM_TTL_MS =
  COMPOSE_UP_TIMEOUT + INSTANT_ROLLBACK_HEALTH_TIMEOUT + COMPOSE_DOWN_TIMEOUT + 6 * COMPOSE_QUERY_TIMEOUT;

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
  const projectPrefix = `${appName}-${env.name}`;
  const activeSlot = (await detectActiveSlot(appDir, projectPrefix)) ?? "blue";

  const standbySlot = activeSlot === "blue" ? "green" : "blue";
  const standbyDir = join(appDir, standbySlot);
  const standbyProjectName = `${projectPrefix}-${standbySlot}`;

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
    // No standby containers.
  }

  return { activeSlot, standbySlot, standbyAvailable, standbyServiceCount };
}

export async function performInstantRollback(
  opts: InstantRollbackOpts,
): Promise<InstantRollbackResult> {
  // A deploy mid-swap owns both slots; flipping under it can leave neither serving.
  const claim = await claimAppForOperation(opts.appId, "instant-rollback", ROLLBACK_CLAIM_TTL_MS);
  if (!claim) {
    return {
      success: false, deploymentId: "", fromSlot: "", toSlot: "", durationMs: 0,
      error: "A deploy is running for this app — wait for it to finish or cancel it, then roll back",
    };
  }
  try {
    return await rollbackClaimed(opts);
  } finally {
    await claim.release();
  }
}

async function rollbackClaimed(
  opts: InstantRollbackOpts,
): Promise<InstantRollbackResult> {
  const { appId, appName, organizationId, userId, env } = opts;
  const startTime = Date.now();
  const appDir = appEnvDir(appName, env.name);

  const projectPrefix = `${appName}-${env.name}`;
  const detectedSlot = await detectActiveSlot(appDir, projectPrefix);
  if (!detectedSlot) {
    return { success: false, deploymentId: "", fromSlot: "", toSlot: "", durationMs: 0, error: "No active deployment" };
  }
  const activeSlot = detectedSlot;

  const standbySlot = activeSlot === "blue" ? "green" : "blue";
  const standbyDir = join(appDir, standbySlot);
  const standbyProjectName = `${projectPrefix}-${standbySlot}`;
  const activeDir = join(appDir, activeSlot);
  const activeProjectName = `${projectPrefix}-${activeSlot}`;

  const standbyComposeFileArgs = await slotComposeFiles(standbyDir);
  const activeComposeFileArgs = await slotComposeFiles(activeDir);

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

  // Drop the cutover pin first: it names the outgoing slot and would 502 the app after the flip.
  await clearCutoverPin(appName, env.name).catch(() => {});

  // Start standby. Rotating services only: an unqualified `up` would start a second database.
  const standbyPartition = await readSlotPartition(standbyDir);
  const onlySlotted = standbyPartition ? slotScopeArgs(standbyPartition) : [];
  try {
    await execFileAsync(
      "docker",
      [
        "compose", ...standbyComposeFileArgs, "-p", standbyProjectName,
        "up", "-d", "--no-recreate", "--pull", "never", ...onlySlotted,
      ],
      { cwd: standbyDir, timeout: COMPOSE_UP_TIMEOUT },
    );
    // About to serve, so restore its restart policy.
    await restoreSlotRestart(standbyComposeFileArgs, standbyProjectName, standbyDir);
  } catch {
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "Failed to start standby slot",
    };
  }

  // Wait for standby containers to run.
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

  // Take the active slot out of Traefik's pool before stopping it.
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

  try {
    await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "stop"],
      { cwd: activeDir, timeout: COMPOSE_DOWN_TIMEOUT },
    );
    // Now the standby; it must not come back on a daemon restart.
    await demoteStandbyRestart(activeComposeFileArgs, activeProjectName, activeDir);
  } catch { /* best-effort — standby is already serving */ }

  // Flip the current symlink.
  const currentSymlinkPath = join(appDir, "current");
  const tmpSymlinkPath = join(appDir, "current.tmp");
  try {
    await rm(tmpSymlinkPath, { force: true });
    await symlink(standbySlot, tmpSymlinkPath, "dir");
    await rename(tmpSymlinkPath, currentSymlinkPath);
  } catch {
    // Bookkeeping only; standby is serving.
  }

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
        .set({ containerName, ...statusChange("active") })
        .where(eq(apps.id, appId));
    }
  } catch { /* best-effort */ }

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
