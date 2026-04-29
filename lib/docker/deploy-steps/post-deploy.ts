// ---------------------------------------------------------------------------
// Deploy Steps 10-12: Old slot teardown, import cleanup, active slot
// recording, image pruning, HTTP health check, volume detection, auto-backup,
// volume limits, cron sync, compose decomposition, config snapshot,
// notifications, activity recording, drift check.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { deployments, apps, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execFile } from "child_process";
import { promisify } from "util";
import { rm, symlink, rename } from "fs/promises";
import { join } from "path";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import {
  isAnonymousVolume,
  slotComposeFiles,
  narrowBackendProtocol,
} from "../compose";
import {
  listContainers,
  inspectContainer,
  removeContainer,
  stripDockerProjectPrefix,
  listImages,
  removeImage,
  pruneImages,
  pruneBuildCache,
} from "../client";
import { syncComposeServices } from "../compose-sync";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { volumeThreshold } from "@/lib/volumes/threshold";
import { DeployBlockedError } from "../errors";
import {
  COMPOSE_DOWN_TIMEOUT,
  POST_DEPLOY_DELAY,
  DOCKER_CLEANUP_TIMEOUT,
  ENDPOINT_CHECK_TIMEOUT,
} from "../constants";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { checkEndpoint, sendDeployNotification } from "../deploy";
import type { DeployContext } from "../deploy-context";

const execFileAsync = promisify(execFile);

export async function postDeploy(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, compose, activeSlot, newSlot, isLocalEnv, hostConfig } = ctx;
  const appDir = ctx.appDir;

  ctx.stage("cleanup", "running");

  // Step 10: Stop old slot containers (skipped for local environments).
  // We stop rather than down so the standby slot's containers remain on disk,
  // enabling instant rollback (compose start + routing flip) without a rebuild.
  if (activeSlot && !isLocalEnv) {
    const oldSlotDir = join(appDir, activeSlot);
    const oldProjectName = `${app.name}-${ctx.envName}-${activeSlot}`;
    const oldComposeFileArgs = await slotComposeFiles(oldSlotDir);
    try {
      await execFileAsync(
        "docker",
        ["compose", ...oldComposeFileArgs, "-p", oldProjectName, "stop"],
        { cwd: oldSlotDir, timeout: COMPOSE_DOWN_TIMEOUT }
      );
      log(`[deploy] Old slot (${activeSlot}) stopped — available for instant rollback`);
    } catch (err) {
      log(`[deploy] Warning: old slot stop — ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 10.5: Clean up original container from import (if any)
  if (app.importedContainerId) {
    try {
      const info = await inspectContainer(app.importedContainerId).catch(() => null);
      if (info && (info.state.status === "running" || info.state.status === "exited")) {
        await removeContainer(app.importedContainerId, { force: true });
        log(`[deploy] Removed original imported container ${app.importedContainerId.slice(0, 12)}`);
      }
    } catch {
      // Best effort
    }
    await db.update(apps).set({ importedContainerId: null, updatedAt: new Date() }).where(eq(apps.id, ctx.appId));
  }

  // Step 11: Record active slot (skipped for local — single directory)
  if (!isLocalEnv) {
    try { await rm(join(appDir, ".active-slot"), { force: true }); } catch { /* gone already */ }

    const currentSymlinkPath = join(appDir, "current");
    const tmpSymlinkPath = join(appDir, "current.tmp");
    try {
      await rm(tmpSymlinkPath, { force: true });
      await symlink(newSlot, tmpSymlinkPath, "dir");
      await rename(tmpSymlinkPath, currentSymlinkPath);
      log(`[deploy] Created 'current' symlink -> ${newSlot}`);
    } catch (err) {
      log(`[deploy] Warning: Failed to create 'current' symlink: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 11.5: Prune old Docker images
  try {
    const { formatBytes } = await import("@/lib/metrics/format");

    if (ctx.builtLocally) {
      const currentImageName = `host/${app.name}:${ctx.deploymentId.slice(0, 8)}`;
      const appImages = await listImages({ reference: [`host/${app.name}`] });
      const imagePrefix = `host/${app.name}:`;
      const staleImages = appImages.filter(
        (img) =>
          img.repoTags.some((tag) => tag.startsWith(imagePrefix)) &&
          !img.repoTags.includes(currentImageName),
      );

      const removeResults = await Promise.allSettled(staleImages.map((img) => removeImage(img.id)));
      const removedCount = removeResults.filter((r) => r.status === "fulfilled").length;

      if (removedCount > 0) {
        log(`[deploy] Removed ${removedCount} old image(s) for ${app.name}`);
      }
    }

    const { spaceReclaimed, count } = await pruneImages({ dangling: ["true"] });
    if (count > 0) {
      log(`[deploy] Pruned ${count} dangling image(s), reclaimed ${formatBytes(spaceReclaimed)}`);
    }

    try {
      const { spaceReclaimed: cacheReclaimed } = await pruneBuildCache({ until: ["24h"] });
      if (cacheReclaimed > 0) {
        log(`[deploy] Pruned build cache, reclaimed ${formatBytes(cacheReclaimed)}`);
      }
    } catch {
      // Build cache pruning is optional
    }
  } catch {
    // Image pruning is best-effort
  }

  ctx.stage("cleanup", "success");

  // Step 12: HTTP health check on domains
  for (const domain of app.domains) {
    const ok = await checkEndpoint(domain.domain, logs);
    if (ok) logs.push(`[health] ${domain.domain} responding`);
    else logs.push(`[health] ${domain.domain} not yet reachable (DNS/TLS propagation)`);
  }

  ctx.stage("done", "success");

  // Auto-detect persistent volumes from running containers
  try {
    const runningContainers = await listContainers(app.name);
    const detectedVolumes: { name: string; mountPath: string }[] = [];
    const seen = new Set<string>();

    for (const c of runningContainers) {
      const info = await inspectContainer(c.id);
      for (const mount of info.mounts) {
        if (mount.type === "volume" && !seen.has(mount.destination) && !isAnonymousVolume(mount.name)) {
          seen.add(mount.destination);
          const name = stripDockerProjectPrefix(mount.name);
          detectedVolumes.push({ name, mountPath: mount.destination });
        }
      }
    }

    if (detectedVolumes.length > 0) {
      const currentVolumes = await db.query.volumes.findMany({
        where: eq(volumes.appId, ctx.appId),
      });
      const existingPaths = new Set(currentVolumes.map((v) => v.mountPath));
      const newDetected = detectedVolumes.filter((v) => !existingPaths.has(v.mountPath));

      if (newDetected.length > 0) {
        for (const vol of newDetected) {
          await db.insert(volumes).values({
            id: nanoid(),
            appId: ctx.appId,
            organizationId: ctx.organizationId,
            name: vol.name,
            mountPath: vol.mountPath,
            persistent: true,
          }).onConflictDoNothing();
        }
        log(`[deploy] Detected ${newDetected.length} volume(s): ${newDetected.map((v) => v.mountPath).join(", ")}`);
      }
    }
  } catch {
    // Volume detection is best-effort
  }

  // Check volume size limits
  try {
    const limitedVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, ctx.appId),
    });
    const anyLimited = limitedVolumes.some((v) => v.maxSizeBytes != null);

    if (anyLimited) {
      const { formatBytes } = await import("@/lib/metrics/format");
      const runningContainers = await listContainers(app.name);

      const volEntries: { volName: string; displayName: string }[] = [];
      for (const c of runningContainers) {
        const info = await inspectContainer(c.id);
        for (const mount of info.mounts) {
          if (mount.type === "volume" && mount.name) {
            const volName = mount.name;
            if (/^[a-zA-Z0-9._-]+$/.test(volName)) {
              const displayName = stripDockerProjectPrefix(volName);
              volEntries.push({ volName, displayName });
            }
          }
        }
      }

      const limitByName = new Map(
        limitedVolumes
          .filter((v) => v.maxSizeBytes != null)
          .map((v) => [v.name, { maxSizeBytes: v.maxSizeBytes!, warnAtPercent: v.warnAtPercent ?? 80 }])
      );

      if (volEntries.length > 0) {
        const results = await Promise.allSettled(
          volEntries.map(({ volName }) =>
            execFileAsync(
              "docker",
              ["run", "--rm", "-v", `${volName}:/data`, "alpine", "du", "-sb", "/data"],
              { timeout: DOCKER_CLEANUP_TIMEOUT }
            )
          )
        );

        let overLimit = false;
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status !== "fulfilled") continue;
          const sizeBytes = parseInt(result.value.stdout.split("\t")[0]);
          if (isNaN(sizeBytes)) continue;
          const { displayName } = volEntries[i];
          const limit = limitByName.get(displayName);
          if (!limit) continue;

          const percent = Math.round((sizeBytes / limit.maxSizeBytes) * 100);
          const level = volumeThreshold(sizeBytes, limit.maxSizeBytes, limit.warnAtPercent);

          if (level === "critical") {
            log(`[deploy] Volume '${displayName}': ${formatBytes(sizeBytes)} / ${formatBytes(limit.maxSizeBytes)} (${percent}%) -- OVER LIMIT, deploy blocked`);
            overLimit = true;
          } else if (level === "warning") {
            log(`[deploy] WARNING: Volume '${displayName}': ${formatBytes(sizeBytes)} / ${formatBytes(limit.maxSizeBytes)} (${percent}%)`);
          } else {
            log(`[deploy] Volume '${displayName}': ${formatBytes(sizeBytes)} / ${formatBytes(limit.maxSizeBytes)} (${percent}%)`);
          }
        }

        if (overLimit) {
          throw new DeployBlockedError("One or more volumes exceed the configured storage limit. Reduce volume usage or increase the limit in app settings.");
        }
      }
    }
  } catch (err) {
    if (err instanceof DeployBlockedError) throw err;
  }

  // Sync cron jobs from template and/or host.toml
  try {
    const { syncCronJobs } = await import("@/lib/cron/engine");
    const cronDefs: { name: string; schedule: string; command: string }[] = [];

    if (hostConfig?.cron?.length) {
      cronDefs.push(...hostConfig.cron);
    }

    if (app.templateName) {
      const { loadTemplates } = await import("@/lib/templates/load");
      const templates = await loadTemplates();
      const tpl = templates.find(t => t.name === app.templateName);
      if (tpl?.defaultCronJobs?.length) {
        cronDefs.push(...tpl.defaultCronJobs);
      }
    }

    if (cronDefs.length > 0) {
      const created = await syncCronJobs(ctx.appId, cronDefs);
      if (created > 0) {
        log(`[deploy] Synced ${created} cron job(s)`);
      }
    }
  } catch (err) {
    log(`[deploy] Warning: cron sync — ${err instanceof Error ? err.message : err}`);
  }

  // Sync compose decomposition
  if (app.deployType === "compose" && Object.keys(compose.services).length > 0) {
    try {
      const syncResult = await syncComposeServices({
        parentAppId: ctx.appId,
        organizationId: ctx.organizationId,
        projectId: app.projectId,
        compose,
        parentAppName: app.name,
        log,
      });
      const totalSync = syncResult.created.length + syncResult.updated.length + syncResult.removed.length;
      if (totalSync > 0) {
        log(`[deploy] Compose decomposition: ${syncResult.created.length} created, ${syncResult.updated.length} updated, ${syncResult.removed.length} removed`);
      }
    } catch (err) {
      log(`[deploy] Warning: compose decomposition — ${err instanceof Error ? err.message : err}`);
    }
  }

  // Mark app as active
  await db
    .update(apps)
    .set({ status: "active", needsRedeploy: false, updatedAt: new Date() })
    .where(eq(apps.id, ctx.appId));

  // Snapshot current config onto deployment record for rollback
  let envSnapshot: string | null = null;
  if (app.envContent) {
    try {
      const { content: rawEnv } = decryptOrFallback(app.envContent, app.organizationId);
      if (rawEnv) {
        envSnapshot = encrypt(rawEnv, app.organizationId);
      }
    } catch { /* best-effort snapshot */ }
  }
  const configSnapshot: ConfigSnapshot = {
    cpuLimit: app.cpuLimit,
    memoryLimit: app.memoryLimit,
    gpuEnabled: app.gpuEnabled ?? false,
    containerPort: app.containerPort,
    imageName: app.imageName,
    gitBranch: app.gitBranch,
    composeFilePath: app.composeFilePath,
    rootDirectory: app.rootDirectory,
    restartPolicy: app.restartPolicy,
    autoTraefikLabels: app.autoTraefikLabels,
    backendProtocol: narrowBackendProtocol(app.backendProtocol),
  };

  const durationMs = Date.now() - ctx.startTime;
  await db
    .update(deployments)
    .set({
      status: "success",
      log: ctx.logLines.join("\n"),
      durationMs,
      finishedAt: new Date(),
      envSnapshot,
      configSnapshot,
      slot: ctx.newSlot,
    })
    .where(eq(deployments.id, ctx.deploymentId));

  // Notify real-time UI via org event stream
  addEvent(ctx.organizationId, {
    type: "deploy.status",
    title: "Deploy succeeded",
    message: `Deployment ${ctx.deploymentId} completed successfully`,
    appId: ctx.appId,
    deploymentId: ctx.deploymentId,
    status: "active",
    success: true,
    durationMs,
  }).catch(() => {});

  recordActivity({
    organizationId: ctx.organizationId,
    action: "deployment.succeeded",
    appId: ctx.appId,
    metadata: { deploymentId: ctx.deploymentId, durationMs },
  }).catch(() => {});

  // Send success notification (non-blocking)
  sendDeployNotification(app, ctx.deploymentId, true, durationMs).catch(() => {});

  // Execute after.deploy.success hooks — plugins handle backup, security scan,
  // rollback monitor, drift check, and any user-registered hooks.
  try {
    const { executeHooks } = await import("@/lib/hooks/execute");
    await executeHooks("after.deploy.success", {
      appId: ctx.appId,
      appName: app.name,
      organizationId: ctx.organizationId,
      deploymentId: ctx.deploymentId,
      deployType: app.deployType,
      activeSlot,
      newSlot,
      isLocalEnv,
      envName: ctx.envName,
      autoRollback: app.autoRollback,
      rollbackGracePeriod: app.rollbackGracePeriod,
      app,
    }, {
      organizationId: ctx.organizationId,
      appId: ctx.appId,
      deployId: ctx.deploymentId,
    });
  } catch (err) {
    log(`[deploy] Warning: post-deploy hooks — ${err instanceof Error ? err.message : err}`);
  }

  return ctx;
}
