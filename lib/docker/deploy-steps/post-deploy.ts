// Deploy steps 10-12: post-swap checks and syncs, the commit, then old-slot stop, cleanup and notifications.

import { deploymentImageName } from "@/lib/docker/image-tag";
import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { setParked } from "@/lib/db/app-parked";
import { deployments, apps, volumes } from "@/lib/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import { readProjectConfig } from "@/lib/config/vardo-config";
import { observedMajors } from "./major-gate";
import { clearMajorGateBlock } from "../image-updates/major-gate-store";
import { runningExcept } from "@/lib/deploy/queue";
import { applyRollbackToApp } from "../rollback-target";
import { backupDrainTimeoutMs, drainBackupsForStop, endBackupDrain } from "@/lib/backups/in-flight";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { BUILD_CACHE_MAX_BYTES, COMPOSE_DOWN_TIMEOUT, ROLLBACK_IMAGES_RETAINED } from "../constants";
import { DeployClosedElsewhereError } from "../errors";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { PRUNE_LOCK_KEY, PRUNE_LOCK_TTL_MS } from "../prune-lock";
import { markDeployForReclaim } from "../host-reclaim/state";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { checkEndpoint, ownedRow, recordSelfUpdate, sendDeployNotification } from "../deploy";
import {
  announcePostDeployIncomplete,
  incompleteLogLine,
  recordPostDeployIncomplete,
} from "../deploy-incomplete";
import { savedLog, type DeployContext, type SlotStopOutcome } from "../deploy-context";
import { isSelfApp } from "../self-env";
import { pointConsoleForwardAt } from "@/lib/mesh/console-forward";
import { CONSOLE_PORT, CONSOLE_SERVICE } from "@/lib/mesh/constants";
import { describeSmoke, smokeStreams } from "../stream-smoke";
import { proposeDurability, isSafeToApply } from "@/lib/backups/durability";
import { refreshDumpSpec } from "@/lib/backups/dump-spec";
import { inferServiceKind } from "@/lib/ui/service-kind";
import { syncDeployComposeDomains } from "@/lib/domains/compose-domains";
import { CERTS_VOLUME_KEY, watchAppCerts } from "@/lib/ssl/cert-export";
import {
  declaredMountPaths,
  describeReconcile,
  isNewSlotContainer,
  planVolumeReconcile,
} from "@/lib/volumes/reconcile";

const POST_DEPLOY_SCAN_DELAY_MS = 30_000;



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

  // Reconcile volume rows with the new slot's mounts. Rows describe the default environment.
  if (!ctx.envIsolated) try {
    // The old slot still runs here; its mounts are the previous compose's.
    const runningContainers = (await listContainers({ id: ctx.appId, name: app.name }, ctx.envName)).filter((c) =>
      isNewSlotContainer(c.labels?.["com.docker.compose.project"], ctx.newProjectName),
    );
    const detectedVolumes: {
      name: string;
      mountPath: string;
      image: string;
      service: string;
      type: "named" | "bind";
      source: string | null;
    }[] = [];
    const seen = new Set<string>();
    let inspectedAll = true;

    for (const c of runningContainers) {
      const info = await inspectContainer(c.id).catch(() => null);
      if (!info) {
        inspectedAll = false;
        continue;
      }
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

    const priorVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, ctx.appId),
    });
    // Removal needs a full view of the new slot.
    const declared =
      runningContainers.length > 0 && inspectedAll && Object.keys(compose.services).length > 0
        ? declaredMountPaths(compose)
        : null;
    const plan = planVolumeReconcile(priorVolumes, detectedVolumes, declared);
    // Rows prepare-repo inserted during this deploy count as found by it.
    const deployStart = new Date(ctx.startTime);
    const touchedIds = priorVolumes.filter((v) => v.createdAt >= deployStart).map((v) => v.id);
    const firstDetection = touchedIds.length === priorVolumes.length;

    for (const update of plan.updates) {
      await db
        .update(volumes)
        .set({ ...update.set, ...(update.resetSelection && { backupSelection: null }), updatedAt: new Date() })
        .where(eq(volumes.id, update.id));
      if (update.resetSelection && !touchedIds.includes(update.id)) touchedIds.push(update.id);
    }
    if (plan.removals.length > 0) {
      await db
        .update(volumes)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(inArray(volumes.id, plan.removals.map((r) => r.id)));
    }
    const reconciled = describeReconcile(plan);
    if (reconciled) log(reconciled);

    if (detectedVolumes.length > 0) {
      const currentVolumes = plan.updates.length
        ? await db.query.volumes.findMany({ where: eq(volumes.appId, ctx.appId) })
        : priorVolumes;
      const existingByPath = new Map(currentVolumes.map((v) => [v.mountPath, v]));
      const newDetected = detectedVolumes.filter((v) => plan.added.some((a) => a.mountPath === v.mountPath));

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
      const excluded = ctx.repoDir
        ? ((await readProjectConfig(ctx.repoDir).catch(() => null))?.environments?.[ctx.envType]?.exclude ?? [])
        : [];
      const syncResult = await syncComposeServices({
        parentAppId: ctx.appId,
        organizationId: ctx.organizationId,
        projectId: app.projectId,
        compose,
        parentAppName: app.name,
        keepServices: [...(ctx.profileSkipped ?? []), ...excluded],
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

  // Hosts the app's own Traefik labels route. Vardo's own stack lists the console's hostname at boot.
  if (!ctx.envIsolated && !app.parentAppId && !ctx.org?.isSystemManaged) {
    try {
      await syncDeployComposeDomains({ app, compose, declaredCompose: ctx.declaredCompose, envMap: ctx.envMap, log });
    } catch (err) {
      log(`[deploy] Warning: compose domains — ${err instanceof Error ? err.message : err}`);
    }
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
  if (!ctx.envIsolated) {
    await clearMajorGateBlock(ctx.appId);
    // Learns which services own a data directory, for the default track policy.
    void import("../image-updates/stateful-probe")
      .then(({ probeAppStateful }) => probeAppStateful({ ...app, id: ctx.appId }))
      .catch(() => {});
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
    composeContent: app.composeContent,
    imageDigest,
    imageMajors,
    deployVars: ctx.deployVars,
  };

  const durationMs = Date.now() - ctx.startTime;
  // Only while still in progress: the sweeper may have closed the row already.
  const recorded = await db
    .update(deployments)
    .set({
      status: "success",
      log: savedLog(ctx),
      durationMs,
      finishedAt: new Date(),
      envSnapshot,
      configSnapshot,
      slot: ctx.newSlot,
      ...(swapUnfinished.length > 0 && { postDeployError: swapUnfinished.join("\n") }),
    })
    .where(ownedRow(ctx.deploymentId, ctx.claimedBy))
    .returning({ id: deployments.id })
    .then((rows) => rows.length > 0);

  // The old slot still runs, so traffic hasn't moved for good: keep it and drop the new slot.
  if (!recorded && ctx.stopOldSlot) {
    log(`[deploy] The deployment was closed elsewhere first; tearing down ${newSlot} and leaving ${activeSlot} serving`);
    await execFileAsync(
      "docker",
      ["compose", ...ctx.composeFileArgs, "-p", ctx.newProjectName, "down", "--remove-orphans"],
      { env: dockerEnv(), cwd: ctx.slotDir, timeout: COMPOSE_DOWN_TIMEOUT },
    ).catch(() => {});
    throw new DeployClosedElsewhereError(null);
  }

  // Committed, or serving under a record closed elsewhere. Nothing below may take the new slot down when it throws.
  ctx.succeeded = true;
  if (!recorded) {
    log(`[deploy] ${newSlot} is serving with no old slot to return to, but the deployment was closed elsewhere first; keeping that record`);
  }

  if (recorded && !ctx.envIsolated) {
    await db
      .update(apps)
      .set({
        ...statusChange("active"),
        needsRedeploy: false,
        ...(ctx.headersLive !== undefined ? { securityHeadersLive: ctx.headersLive } : {}),
        kind: inferServiceKind({
          image: app.imageName,
          serviceName: app.composeService ?? app.name,
          hasPort: !!app.containerPort || app.domains.length > 0,
        }),
      })
      .where(eq(apps.id, ctx.appId));

    // A successful deploy clears the operator stop.
    await setParked(ctx.appId, false);

    if (ctx.rollbackTarget) await applyRollbackToApp(ctx.appId, app.organizationId, ctx.rollbackTarget, log);
  }

  for (const reason of swapUnfinished) await announcePostDeployIncomplete(ctx, reason);

  if (!isLocalEnv) {
    try {
      await pointCurrentAt(appDir, newSlot);
      log(`[deploy] Created 'current' symlink -> ${newSlot}`);
    } catch (err) {
      log(`[deploy] Warning: Failed to create 'current' symlink: ${err instanceof Error ? err.message : err}`);
    }
    if (isSelfApp(app.name)) await pointConsoleForwardAt(ctx.newProjectName, log);
  }

  // The new console's live stats, while the old slot's worker holds the loops.
  if (!isLocalEnv && !ctx.envIsolated && isSelfApp(app.name)) {
    try {
      const outcome = await smokeStreams(`http://${ctx.newProjectName}-${CONSOLE_SERVICE}-1:${CONSOLE_PORT}`, {
        orgId: ctx.organizationId,
        appId: ctx.appId,
        projectId: app.projectId,
      });
      const { lines, failure } = describeSmoke(outcome, newSlot);
      for (const line of lines) log(line);
      if (failure) await unfinishedWork(failure);
    } catch (err) {
      log(`[smoke] Live stats streams not checked: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (ctx.stopOldSlot && !ctx.stopOldSlotEndsDeploy) {
    await stopOldSlot();
  }

  // Traefik issues certs after `up`; the watch outlives the deploy and appends to its log.
  if (app.certServices?.length && !ctx.envIsolated) {
    const appendLog = (line: string) => {
      db.update(deployments)
        .set({ log: sql`coalesce(${deployments.log}, '') || ${`\n${line}`}` })
        .where(eq(deployments.id, ctx.deploymentId))
        .catch(() => {});
    };
    await watchAppCerts(ctx.appId, log, appendLog).catch((err) =>
      log(`[certs] Couldn't read Traefik's certificates: ${err instanceof Error ? err.message : err}`),
    );
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

    // Keeps the retained rollback targets' images; a preview leaves production's alone.
    if (ctx.builtLocally && !ctx.envIsolated) {
      const retained = await db.query.deployments.findMany({
        where: and(eq(deployments.appId, ctx.appId), eq(deployments.status, "success")),
        orderBy: [desc(deployments.startedAt)],
        limit: ROLLBACK_IMAGES_RETAINED,
        columns: { id: true },
      });
      const keep = new Set([ctx.deploymentId, ...retained.map((d) => d.id)].map((id) => deploymentImageName(app.name, id)));
      const appImages = await listImages({ reference: [`host/${app.name}`] });
      const imagePrefix = `host/${app.name}:`;
      const staleImages = appImages.filter(
        (img) =>
          img.repoTags.some((tag) => tag.startsWith(imagePrefix)) &&
          !img.repoTags.some((tag) => keep.has(tag)),
      );

      const removeResults = await Promise.allSettled(staleImages.map((img) => removeImage(img.id)));
      const removedCount = removeResults.filter((r) => r.status === "fulfilled").length;

      if (removedCount > 0) {
        log(`[deploy] Removed ${removedCount} old image(s) for ${app.name}`);
      }
    }

    // Host-global prunes delete layers other in-flight pulls are writing; only the last deploy prunes.
    const drained = (await runningExcept(ctx.deploymentId).catch(() => 1)) === 0;
    const pruneLock = drained ? await acquireLock(PRUNE_LOCK_KEY, PRUNE_LOCK_TTL_MS) : null;
    if (!drained) {
      log("[deploy] Deferring image prune — other deploys are still in flight");
    } else if (!pruneLock) {
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
        await releaseLock(PRUNE_LOCK_KEY, pruneLock).catch(() => {});
      }
    }
  } catch {
    // Best-effort.
  }
  await markDeployForReclaim().catch(() => {});

  ctx.stage("cleanup", "success");

  // Closes the deploy stream; must follow the success write.
  ctx.stage("done", "success");

  // Announcements are fire-and-forget. A record closed elsewhere was announced there.
  if (recorded) {
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
  }

  // Waits for Traefik to route to the new slot.
  const { organizationId, appId } = ctx;
  setTimeout(() => {
    import("@/lib/security/scanner")
      .then(({ runSecurityScan }) => runSecurityScan({ appId, organizationId, trigger: "deploy" }))
      .catch(() => {});
  }, POST_DEPLOY_SCAN_DELAY_MS).unref();

  if (recorded) {
    sendDeployNotification({
      app,
      deploymentId: ctx.deploymentId,
      success: true,
      durationMs,
      ctx,
      trigger: ctx.trigger,
      stageTimings: ctx.timer?.snapshot(),
    }).catch(() => {});
  }

  if (!ctx.envIsolated) {
    import("@/lib/backups/initial-backup")
      .then(({ armInitialBackupQuietly }) => armInitialBackupQuietly(ctx.appId, "deploy"))
      .catch(() => {});
  }

  // Auto-rollback can't watch Vardo itself; the watcher dies with the slot.
  if (app.autoRollback && isSelfApp(app.name) && activeSlot) {
    log(
      `[deploy] Auto-rollback is not armed for Vardo itself — use instant rollback (${activeSlot} is a warm standby) if this release misbehaves`,
    );
  }

  // A file write, not a scheduled action: the new console reads it on boot and announces the update.
  await recordSelfUpdate(ctx, { state: "updated", finishedAt: Date.now() });

  // The old slot runs this process, so this stop must stay last.
  if (ctx.stopOldSlot && ctx.stopOldSlotEndsDeploy) {
    // Waits on and pauses the old slot's worker too.
    const backupsCutOff = await drainBackupsForStop(log, backupDrainTimeoutMs(), 1000, { slot: activeSlot }).catch(() => [] as string[]);
    if (backupsCutOff.length > 0) {
      await unfinishedWork(
        `the stop cut off backup work still running after ${backupDrainTimeoutMs() / 60_000} minutes, so the new console reruns it: ${backupsCutOff.join(", ")}`,
      );
    }
    log(`[deploy] Stopping the slot running this deploy — ${newSlot} is serving`);
    // A slot that won't stop keeps serving, so it takes deploys and backups again.
    if (!(await stopOldSlot())) endBackupDrain();
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
