import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { apps, deployments } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { rm, symlink, rename } from "fs/promises";
import { join } from "path";
import { nanoid } from "nanoid";
import { appEnvDir } from "@/lib/paths";
import { slotComposeFiles } from "./compose";
import { detectActiveSlot } from "./slots";
import { slotScopeArgs } from "./slot-partition";
import { readSlotBound, readSlotHostPorts, readSlotPartition } from "./shared-project";
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
import { assertSlotWithinApp } from "./slot-guard";
import { isScopeConflict, scopeKeyFor } from "@/lib/deploy/queue";
import { instanceId } from "@/lib/worker/instance";
import { dockerEnv } from "@/lib/docker/docker-env";
import { isSelfApp } from "./self-env";
import { pointConsoleForwardAt } from "@/lib/mesh/console-forward";

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
  /** The app's stop-first setting: stop the active slot before the standby starts. */
  stopFirst?: boolean;
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
      { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const containers = stdout.trim().split("\n").filter(Boolean);
    standbyServiceCount = containers.length;
    standbyAvailable = containers.length > 0;
  } catch {
    // No standby containers.
  }

  return { activeSlot, standbySlot, standbyAvailable, standbyServiceCount };
}

/** Takes the environment's scope with a running row, as a deploy would. Null when a deploy holds it. */
async function claimScopeRow(opts: InstantRollbackOpts): Promise<string | null> {
  const id = nanoid();
  try {
    await db.insert(deployments).values({
      id,
      appId: opts.appId,
      status: "running",
      trigger: "rollback",
      triggeredBy: opts.userId,
      environmentId: opts.env.id,
      scopeKey: await scopeKeyFor(opts.appId, opts.env.id),
      claimedBy: instanceId(),
      leaseExpiresAt: sql`now() + ${ROLLBACK_CLAIM_TTL_MS}::int * interval '1 millisecond'`,
      log: "[rollback] Instant rollback in progress",
    });
    return id;
  } catch (err) {
    if (isScopeConflict(err)) return null;
    throw err;
  }
}

export async function performInstantRollback(
  opts: InstantRollbackOpts,
): Promise<InstantRollbackResult> {
  // A deploy mid-swap owns both slots; flipping under it can leave neither serving.
  const claimId = await claimScopeRow(opts);
  if (!claimId) {
    return {
      success: false, deploymentId: "", fromSlot: "", toSlot: "", durationMs: 0,
      error: "A deploy is running for this app — wait for it to finish or cancel it, then roll back",
    };
  }
  let result: InstantRollbackResult | null = null;
  try {
    result = await rollbackClaimed(opts, claimId);
    return result;
  } finally {
    // Only a rollback that swapped keeps its row.
    if (!result?.success) await db.delete(deployments).where(eq(deployments.id, claimId)).catch(() => {});
  }
}

async function rollbackClaimed(
  opts: InstantRollbackOpts,
  deploymentId: string,
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
      { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
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

  try {
    await assertSlotWithinApp({ appName, envName: env.name, slotDir: standbyDir, composeProject: standbyProjectName, reuse: "rollback" });
  } catch (err) {
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Drop the cutover pin first: it names the outgoing slot and would 502 the app after the flip.
  await clearCutoverPin(appName, env.name).catch(() => {});

  // A service on a directory both slots address or on host ports can't run twice, so the active slot stops first. Stop-first apps too.
  const slotBound = await readSlotBound(standbyDir);
  // Vardo's own active slot runs this rollback.
  const hostPorts = isSelfApp(appName) ? [] : await readSlotHostPorts(standbyDir);
  const stopActiveFirst = slotBound.length > 0 || hostPorts.length > 0 || opts.stopFirst === true;
  const blocking = [...new Set([...slotBound, ...hostPorts.map((h) => h.service)])];
  const restartActive = async () => {
    if (!stopActiveFirst) return;
    await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "start"],
      { env: dockerEnv(), cwd: activeDir, timeout: COMPOSE_UP_TIMEOUT },
    ).catch(() => {});
  };
  if (stopActiveFirst) {
    try {
      await execFileAsync(
        "docker",
        ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "stop"],
        { env: dockerEnv(), cwd: activeDir, timeout: COMPOSE_DOWN_TIMEOUT },
      );
    } catch {
      await restartActive();
      return {
        success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
        durationMs: Date.now() - startTime,
        error: `Couldn't stop ${activeSlot} before starting ${blocking.length > 0 ? blocking.join(", ") : standbySlot} on the standby`,
      };
    }
  }

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
      { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_UP_TIMEOUT },
    );
    // About to serve, so restore its restart policy.
    await restoreSlotRestart(standbyComposeFileArgs, standbyProjectName, standbyDir);
  } catch {
    await restartActive();
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "Couldn't start the standby",
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
        { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
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
      { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_DOWN_TIMEOUT },
    ).catch(() => {});
    await restartActive();
    return {
      success: false, deploymentId: "", fromSlot: activeSlot, toSlot: standbySlot,
      durationMs: Date.now() - startTime,
      error: "Standby containers failed to start — use standard rollback",
    };
  }

  if (isSelfApp(appName)) await pointConsoleForwardAt(standbyProjectName, () => {});

  // Take the active slot out of Traefik's pool before stopping it.
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "ps", "-q"],
      { env: dockerEnv(), cwd: activeDir, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    for (const id of stdout.trim().split("\n").filter(Boolean)) {
      await execFileAsync(
        "docker",
        ["network", "disconnect", "-f", NETWORK_NAME, id],
        { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT },
      ).catch(() => {});
    }
  } catch { /* best-effort */ }

  try {
    await execFileAsync(
      "docker",
      ["compose", ...activeComposeFileArgs, "-p", activeProjectName, "stop"],
      { env: dockerEnv(), cwd: activeDir, timeout: COMPOSE_DOWN_TIMEOUT },
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
      { env: dockerEnv(), cwd: standbyDir, timeout: COMPOSE_QUERY_TIMEOUT },
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

  const standbyDeploy = await db.query.deployments.findFirst({
    where: and(
      eq(deployments.appId, appId),
      eq(deployments.status, "success"),
      eq(deployments.slot, standbySlot),
    ),
    orderBy: [desc(deployments.startedAt)],
    columns: { id: true, gitSha: true, gitMessage: true, environmentId: true },
  });

  await db
    .update(deployments)
    .set({
      status: "success",
      gitSha: standbyDeploy?.gitSha ?? null,
      gitMessage: standbyDeploy?.gitMessage ?? null,
      log: `[rollback] Instant rollback: ${activeSlot} → ${standbySlot} (${durationMs}ms)`,
      durationMs,
      slot: standbySlot,
      rollbackFromId: standbyDeploy?.id ?? null,
      environmentId: standbyDeploy?.environmentId ?? env.id,
      finishedAt: new Date(),
    })
    .where(eq(deployments.id, deploymentId));

  addEvent(organizationId, {
    type: "deploy.status",
    title: "Instant rollback",
    message: `Rolled back to the previous deploy in ${durationMs}ms`,
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
