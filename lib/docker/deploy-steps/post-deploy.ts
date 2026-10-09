// Deploy steps 10-12: post-swap checks and syncs, the commit, then old-slot stop, cleanup and notifications.

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { setParked } from "@/lib/db/app-parked";
import { deployments, apps, volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { formatRoute } from "@/lib/domains/path-prefix";
import { nanoid } from "nanoid";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { pointCurrentAt } from "../active-slot";
import {
  isAnonymousVolume,
  narrowBackendProtocol,
} from "../compose";
import {
  listContainers,
  inspectContainer,
  removeContainer,
  volumeNameFromMount,
  listImages,
  inspectImageDigest,
  removeImage,
  pruneImages,
  pruneBuildCache,
} from "../client";
import { syncComposeServices } from "../compose-sync";
import { observedMajors } from "./major-gate";
import { clearMajorGateBlock } from "../image-updates/major-gate-store";
import { isDeployQueueDrained, releaseConcurrencySlot } from "../deploy-concurrency";
import { drainForSelfStop, endSelfDrain, SELF_DRAIN_TIMEOUT_MS } from "../deploy-cancel";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { BUILD_CACHE_MAX_BYTES } from "../constants";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { checkEndpoint, sendDeployNotification } from "../deploy";
import {
  announcePostDeployIncomplete,
  incompleteLogLine,
  recordPostDeployIncomplete,
} from "../deploy-incomplete";
import type { DeployContext, SlotStopOutcome } from "../deploy-context";
import { isSelfApp } from "../self-env";
import { proposeDurability, isSafeToApply } from "@/lib/backups/durability";
import { refreshDumpSpec } from "@/lib/backups/dump-spec";
import { CERTS_VOLUME_KEY } from "@/lib/ssl/cert-export";

/** Serializes the host-global prune across deploys. */
const PRUNE_LOCK_KEY = "deploy:prune:lock";
const PRUNE_LOCK_TTL_MS = 5 * 60_000;


export async function postDeploy(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, compose, activeSlot, newSlot, isLocalEnv, hostConfig } = ctx;
  const appDir = ctx.appDir;

  ctx.stage("cleanup", "running");

  // Raised by the swap; written with the commit so a self-deploy's stop can't lose them.
  const swapUnfinished = ctx.unfinished?.splice(0) ?? [];
  for (const reason of swapUnfinished) log(incompleteLogLine(reason));

  const unfinishedWork = (reason: string) => recordPostDeployIncomplete(ctx, reason);

  const stopOldSlot = async () => {
    const stopped = await ctx.stopOldSlot!().then(
      (outcome) => outcome,
      (err: unknown): SlotStopOutcome => ({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    if (!stopped.ok) {
      await unfinishedWork(`the old slot (${activeSlot}) is still running — ${stopped.message}`);
    }
    return stopped.ok;
  };

  // Step 12: HTTP check on domains.
  for (const domain of app.domains) {
    const route = formatRoute(domain.domain, domain.pathPrefix);
    const ok = await checkEndpoint(route, logs);
    if (ok) logs.push(`[health] ${route} responding`);
    else logs.push(`[health] ${route} not yet reachable (DNS/TLS propagation)`);
  }

  // Detect volumes from running containers. Rows describe the default environment.
  if (!ctx.envIsolated) try {
    const runningContainers = await listContainers({ id: ctx.appId, name: app.name }, ctx.envName);
    const detectedVolumes: {
      name: string;
      mountPath: string;
      image: string;
      service: string;
      type: "named" | "bind";
      source: string | null;
    }[] = [];
    const seen = new Set<string>();

    for (const c of runningContainers) {
      const info = await inspectContainer(c.id);
      for (const mount of info.mounts) {
        if (seen.has(mount.destination)) continue;

        // Bind mounts are recorded too (#763).
        const isBind = mount.type === "bind";
        const isNamed = mount.type === "volume" && !isAnonymousVolume(mount.name);
        if (!isBind && !isNamed) continue;
        // Vardo's cert volume is rebuilt from Traefik; it's no app data.
        if (isNamed && mount.name?.endsWith(`_${CERTS_VOLUME_KEY}`)) continue;

        seen.add(mount.destination);
        detectedVolumes.push({
          name: volumeNameFromMount(mount),
          mountPath: mount.destination,
          image: info.image,
          service: info.labels["com.docker.compose.service"] ?? "",
          type: isBind ? "bind" : "named",
          source: isBind ? mount.source : null,
        });
      }
    }

    if (detectedVolumes.length > 0) {
      const currentVolumes = await db.query.volumes.findMany({
        where: eq(volumes.appId, ctx.appId),
      });
      const existingByPath = new Map(currentVolumes.map((v) => [v.mountPath, v]));
      const newDetected = detectedVolumes.filter((v) => !existingByPath.has(v.mountPath));
      // Rows prepare-repo inserted during this deploy count as found by it.
      const deployStart = new Date(ctx.startTime);
      const touchedIds = currentVolumes.filter((v) => v.createdAt >= deployStart).map((v) => v.id);
      const firstDetection = touchedIds.length === currentVolumes.length;

      // A mount path whose source changed is a different volume; reset its backup selection.
      for (const vol of detectedVolumes) {
        const row = existingByPath.get(vol.mountPath);
        if (!row || (row.type === vol.type && (vol.type !== "bind" || row.source === vol.source))) continue;
        await db
          .update(volumes)
          .set({ type: vol.type, source: vol.source, backupSelection: null, updatedAt: new Date() })
          .where(eq(volumes.id, row.id));
        if (!touchedIds.includes(row.id)) touchedIds.push(row.id);
        log(`[deploy] ${vol.mountPath} now mounts ${vol.source ?? vol.name}`);
      }

      // A renamed service or changed engine moves the dump target; user-set fields stay.
      for (const vol of detectedVolumes) {
        const row = existingByPath.get(vol.mountPath);
        if (!row?.backupSpec) continue;
        const spec = refreshDumpSpec(row.backupSpec, {
          image: vol.image,
          mountPath: vol.mountPath,
          volumeName: vol.name,
          service: vol.service,
        });
        if (!spec) continue;
        await db.update(volumes).set({ backupSpec: spec, updatedAt: new Date() }).where(eq(volumes.id, row.id));
        log(`[deploy] ${row.name} dump target is now ${spec.kind} service "${spec.service}"`);
      }

      // Rows inserted before the containers ran are classified here once.
      for (const vol of detectedVolumes) {
        const row = existingByPath.get(vol.mountPath);
        if (!row || row.durability != null || row.backupSpec != null || row.backupStrategy === "dump") continue;
        const proposal = proposeDurability({ image: vol.image, mountPath: vol.mountPath, volumeName: vol.name });
        if (!proposal?.kind || !vol.service || !isSafeToApply(null, proposal.durability)) continue;
        if (proposal.newVolumesOnly && row.createdAt < deployStart) continue;
        const spec = { kind: proposal.kind, service: vol.service };
        await db
          .update(volumes)
          .set({ durability: "stateful", backupStrategy: "dump", backupSpec: spec, updatedAt: new Date() })
          .where(eq(volumes.id, row.id));
        if (!touchedIds.includes(row.id)) touchedIds.push(row.id);
        log(`[deploy] ${row.name} will back up with ${spec.kind} dump via service "${spec.service}"`);
      }

      if (newDetected.length > 0) {
        for (const vol of newDetected) {
          // Only `stateful` is applied unprompted; a wrong `rebuildable` would cost data.
          const proposal = proposeDurability({
            image: vol.image,
            mountPath: vol.mountPath,
            volumeName: vol.name,
          });
          const durability =
            proposal && isSafeToApply(null, proposal.durability) ? proposal.durability : null;

          // Recognized databases are dumped, keyed by compose service so the spec survives slot swaps.
          const spec =
            durability === "stateful" && proposal?.kind && vol.service
              ? { kind: proposal.kind, service: vol.service }
              : null;

          const volumeId = nanoid();
          touchedIds.push(volumeId);
          await db.insert(volumes).values({
            id: volumeId,
            appId: ctx.appId,
            organizationId: ctx.organizationId,
            name: vol.name,
            mountPath: vol.mountPath,
            type: vol.type,
            source: vol.source,
            // `persistent` means Vardo externalized it, not whether the data matters.
            persistent: vol.type !== "bind",
            durability,
            backupStrategy: spec ? "dump" : "tar",
            backupSpec: spec,
          }).onConflictDoNothing();

          if (durability) {
            log(`[deploy] ${vol.name} classified ${durability} — ${proposal!.reason}`);
          }
          if (spec) {
            log(`[deploy] ${vol.name} will back up with ${spec.kind} dump via service "${spec.service}"`);
          }
        }
        log(`[deploy] Detected ${newDetected.length} volume(s): ${newDetected.map((v) => v.mountPath).join(", ")}`);
      }

      if (touchedIds.length > 0) {
        await enrollDetectedVolumes(ctx, app.name, firstDetection, touchedIds, log);
      }
    }
  } catch {
    // Best-effort.
  }

  // Sync cron jobs from the template and host.toml.
  if (!ctx.envIsolated) try {
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

  // A preview's compose must never add or remove production's children.
  if (!ctx.envIsolated && app.deployType === "compose" && Object.keys(compose.services).length > 0) {
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

  if (!ctx.envIsolated) {
    await db
      .update(apps)
      .set({ ...statusChange("active"), needsRedeploy: false })
      .where(eq(apps.id, ctx.appId));

    // A successful deploy clears the operator stop.
    await setParked(ctx.appId, false);
  }

  // Config snapshot for rollback.
  let envSnapshot: string | null = null;
  if (app.envContent) {
    try {
      const { content: rawEnv } = decryptOrFallback(app.envContent, app.organizationId);
      if (rawEnv) {
        envSnapshot = encrypt(rawEnv, app.organizationId);
      }
    } catch { /* best-effort snapshot */ }
  }
  // Image apps pin by digest on rollback — a tag can be re-pointed.
  const imageDigest =
    app.deployType === "image" && app.imageName
      ? await inspectImageDigest(app.imageName)
      : null;

  // Record engine majors as the gate baseline and clear any previous block.
  const imageMajors = await observedMajors(ctx).catch(() => ({}));
  if (!ctx.envIsolated) await clearMajorGateBlock(ctx.appId);

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
    composeContent: app.composeContent,
    imageDigest,
    imageMajors,
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
      ...(swapUnfinished.length > 0 && { postDeployError: swapUnfinished.join("\n") }),
    })
    .where(eq(deployments.id, ctx.deploymentId));

  // Committed. Nothing below may take the new slot down when it throws.
  ctx.succeeded = true;

  for (const reason of swapUnfinished) await announcePostDeployIncomplete(ctx, reason);

  if (!isLocalEnv) {
    try {
      await pointCurrentAt(appDir, newSlot);
      log(`[deploy] Created 'current' symlink -> ${newSlot}`);
    } catch (err) {
      log(`[deploy] Warning: Failed to create 'current' symlink: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (ctx.stopOldSlot && !ctx.stopOldSlotEndsDeploy) {
    await stopOldSlot();
  }

  // The imported original is removed only after the deploy commits.
  if (app.importedContainerId && !ctx.envIsolated) {
    try {
      const info = await inspectContainer(app.importedContainerId).catch(() => null);
      if (info && (info.state.status === "running" || info.state.status === "exited")) {
        await removeContainer(app.importedContainerId, { force: true });
        log(`[deploy] Removed original imported container ${app.importedContainerId.slice(0, 12)}`);
      }
      await db.update(apps).set({ importedContainerId: null, updatedAt: new Date() }).where(eq(apps.id, ctx.appId));
    } catch {
      // Best-effort.
    }
  }

  // Prune old images.
  try {
    const { formatBytes } = await import("@/lib/metrics/format");

    // Production's older tags are its rollback targets; a preview leaves them alone.
    if (ctx.builtLocally && !ctx.envIsolated) {
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

    // Host-global prunes delete layers other in-flight pulls are writing; only the last deploy prunes.
    if (!(await isDeployQueueDrained())) {
      log("[deploy] Deferring image prune — other deploys are still in flight");
    } else if (!(await acquireLock(PRUNE_LOCK_KEY, PRUNE_LOCK_TTL_MS))) {
      log("[deploy] Deferring image prune — another prune is already running");
    } else {
      try {
        const { spaceReclaimed, count } = await pruneImages({ dangling: ["true"] });
        if (count > 0) {
          log(`[deploy] Pruned ${count} dangling image(s), reclaimed ${formatBytes(spaceReclaimed)}`);
        }

        try {
          // Size ceiling, not age window.
          const { spaceReclaimed: cacheReclaimed } = await pruneBuildCache(undefined, {
            keepStorage: BUILD_CACHE_MAX_BYTES,
          });
          if (cacheReclaimed > 0) {
            log(
              `[deploy] Build cache over ${formatBytes(BUILD_CACHE_MAX_BYTES)}, ` +
                `reclaimed ${formatBytes(cacheReclaimed)}`,
            );
          }
        } catch {
          // Best-effort.
        }
      } finally {
        await releaseLock(PRUNE_LOCK_KEY).catch(() => {});
      }
    }
  } catch {
    // Best-effort.
  }

  ctx.stage("cleanup", "success");

  // Closes the deploy stream; must follow the success write.
  ctx.stage("done", "success");

  // Announcements are fire-and-forget.
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

  sendDeployNotification({
    app,
    deploymentId: ctx.deploymentId,
    success: true,
    durationMs,
    ctx,
    trigger: ctx.trigger,
    stageTimings: ctx.timer?.snapshot(),
  }).catch(() => {});

  // Auto-rollback can't watch Vardo itself; the watcher dies with the slot.
  if (app.autoRollback && isSelfApp(app.name) && activeSlot) {
    log(
      `[deploy] Auto-rollback is not armed for Vardo itself — use instant rollback (${activeSlot} is a warm standby) if this release misbehaves`,
    );
  }

  // The old slot runs this process, so this stop must stay last.
  if (ctx.stopOldSlot && ctx.stopOldSlotEndsDeploy) {
    // The usual `finally` release never runs once this process stops.
    await releaseConcurrencySlot(ctx.deploymentId).catch(() => {});
    const cutOff = await drainForSelfStop(ctx.appId, log).catch(() => [] as string[]);
    if (cutOff.length > 0) {
      await unfinishedWork(
        `the stop cut off deploy(s) still running after ${SELF_DRAIN_TIMEOUT_MS / 60_000} minutes: ${cutOff.join(", ")}`,
      );
    }
    log(`[deploy] Stopping the slot running this deploy — ${newSlot} is serving`);
    // A slot that won't stop keeps serving, so it takes deploys again.
    if (!(await stopOldSlot())) endSelfDrain();
  }

  return ctx;
}

/** Enroll detected volumes in backups. Never blocks the deploy. */
async function enrollDetectedVolumes(
  ctx: DeployContext,
  appName: string,
  firstDetection: boolean,
  volumeIds: string[],
  log: (line: string) => void,
): Promise<void> {
  try {
    const { enrollNewApp, enrollNewVolumes } = await import("@/lib/backups/enroll");
    if (firstDetection) {
      const result = await enrollNewApp({
        appId: ctx.appId,
        appName,
        organizationId: ctx.organizationId,
        measure: true,
      });
      if (result.status === "covered" && result.jobId) log(`[deploy] Backups: added to job ${result.jobId}`);
      if (result.status === "no-target") log("[deploy] Backups: no target configured — app is not backed up");
      if (result.status === "off") log("[deploy] Backups: off for this app");
      return;
    }
    const { backupJobApps } = await import("@/lib/db/schema");
    const links = await db.query.backupJobApps.findMany({
      where: eq(backupJobApps.appId, ctx.appId),
      with: { backupJob: { columns: { organizationId: true } } },
    });
    const covered = links.some(
      (l) => l.backupJob.organizationId === ctx.organizationId || l.backupJob.organizationId === null,
    );
    await enrollNewVolumes({ appId: ctx.appId, appName, volumeIds, covered });
  } catch (err) {
    log(`[deploy] Warning: backup enrollment — ${err instanceof Error ? err.message : err}`);
  }
}
