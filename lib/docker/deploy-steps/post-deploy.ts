// ---------------------------------------------------------------------------
// Deploy Steps 10-12: HTTP health check, volume detection, cron sync, compose
// decomposition and config snapshot, then the commit. After it: active slot
// recording, old slot stop, import cleanup, image pruning, notifications and
// hooks.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { setParked } from "@/lib/db/app-parked";
import { deployments, apps, volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { addEvent } from "@/lib/stream/producer";
import { recordActivity } from "@/lib/activity";
import { pruneBuildKitCache, DEFAULT_BUILDKIT_HOST } from "../buildkit";
import {
  BUILD_CACHE_MAX_BYTES,
  BUILDKIT_CACHE_MAX_BYTES,
} from "../constants";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { checkEndpoint, sendDeployNotification } from "../deploy";
import { recordPostDeployIncomplete } from "../deploy-incomplete";
import type { DeployContext, SlotStopOutcome } from "../deploy-context";
import { isSelfApp } from "../self-env";
import { proposeDurability, isSafeToApply } from "@/lib/backups/durability";

/** Serializes the host-global prune across deploys. */
const PRUNE_LOCK_KEY = "deploy:prune:lock";
const PRUNE_LOCK_TTL_MS = 5 * 60_000;


export async function postDeploy(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, compose, activeSlot, newSlot, isLocalEnv, hostConfig } = ctx;
  const appDir = ctx.appDir;

  ctx.stage("cleanup", "running");

  // Work this step could not finish. Held until the deploy commits — before
  // that there is no success for it to qualify.
  const pendingUnfinished: string[] = [];
  const unfinishedWork = async (reason: string) => {
    if (!ctx.succeeded) {
      pendingUnfinished.push(reason);
      return;
    }
    await recordPostDeployIncomplete(ctx, reason);
  };

  // Raised by the swap, which ran before there was a success to qualify them.
  for (const reason of ctx.unfinished?.splice(0) ?? []) {
    await unfinishedWork(reason);
  }

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
  };

  // Step 12: HTTP health check on domains
  for (const domain of app.domains) {
    const ok = await checkEndpoint(domain.domain, logs);
    if (ok) logs.push(`[health] ${domain.domain} responding`);
    else logs.push(`[health] ${domain.domain} not yet reachable (DNS/TLS propagation)`);
  }

  // Auto-detect persistent volumes from running containers
  try {
    const runningContainers = await listContainers({ id: ctx.appId, name: app.name });
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

        // Bind mounts are recorded too. Only the import path used to do this,
        // so an app deployed normally with host mounts had no volume rows at
        // all and could never opt them into backup (#763).
        const isBind = mount.type === "bind";
        const isNamed = mount.type === "volume" && !isAnonymousVolume(mount.name);
        if (!isBind && !isNamed) continue;

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
      const existingPaths = new Set(currentVolumes.map((v) => v.mountPath));
      const newDetected = detectedVolumes.filter((v) => !existingPaths.has(v.mountPath));

      if (newDetected.length > 0) {
        for (const vol of newDetected) {
          // Only a `stateful` proposal is written unprompted. A wrong
          // `stateful` costs storage; a wrong `rebuildable` costs the data.
          const proposal = proposeDurability({
            image: vol.image,
            mountPath: vol.mountPath,
            volumeName: vol.name,
          });
          const durability =
            proposal && isSafeToApply(null, proposal.durability) ? proposal.durability : null;

          // A recognized database gets dumped rather than archived. The spec
          // stores the compose service, which survives the blue/green swap that
          // a container name would not.
          const spec =
            durability === "stateful" && proposal?.kind && vol.service
              ? { kind: proposal.kind, service: vol.service }
              : null;

          await db.insert(volumes).values({
            id: nanoid(),
            appId: ctx.appId,
            organizationId: ctx.organizationId,
            name: vol.name,
            mountPath: vol.mountPath,
            type: vol.type,
            source: vol.source,
            // A bind mount survives a deploy because it lives on the host, so
            // there is nothing for Vardo to externalize. That is what
            // `persistent` records — not whether the data matters.
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
    }
  } catch {
    // Volume detection is best-effort
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
    .set({ ...statusChange("active"), needsRedeploy: false })
    .where(eq(apps.id, ctx.appId));

  // A deploy that landed is a decision to run this, so it stops being parked.
  await setParked(ctx.appId, false);

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
  // Image apps pin by digest on rollback — a tag can be re-pointed.
  const imageDigest =
    app.deployType === "image" && app.imageName
      ? await inspectImageDigest(app.imageName)
      : null;

  // Engine majors for the deploy gate's baseline, and the block it may have
  // written last time — this deploy is the answer to it.
  const imageMajors = await observedMajors(ctx).catch(() => ({}));
  await clearMajorGateBlock(ctx.appId);

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
    })
    .where(eq(deployments.id, ctx.deploymentId));

  // Committed. Nothing below may take the new slot down when it throws.
  ctx.succeeded = true;

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

  // The imported original is the last copy of the app outside Vardo, so it
  // goes only once the deploy has committed.
  if (app.importedContainerId) {
    try {
      const info = await inspectContainer(app.importedContainerId).catch(() => null);
      if (info && (info.state.status === "running" || info.state.status === "exited")) {
        await removeContainer(app.importedContainerId, { force: true });
        log(`[deploy] Removed original imported container ${app.importedContainerId.slice(0, 12)}`);
      }
      await db.update(apps).set({ importedContainerId: null, updatedAt: new Date() }).where(eq(apps.id, ctx.appId));
    } catch {
      // Best effort
    }
  }

  // Prune old Docker images
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

    // The dangling prune and build-cache prune are host-global. Running them
    // while another deploy is pulling deletes layers that pull is still writing
    // ("failed commit on ref ... no such file or directory"). Defer until this
    // is the last deploy in flight; the deploy that finishes last does it.
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
          // A size ceiling, not an age window. An age window reclaims nothing on
          // a host deploying several times a day, because nothing gets that old.
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
          // Build cache pruning is optional
        }

        try {
          // Railpack's cache lives in the buildkit daemon's own store, on its
          // own volume, and the prune above never reaches it.
          const { spaceReclaimed: buildKitReclaimed } = await pruneBuildKitCache(
            process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST,
            BUILDKIT_CACHE_MAX_BYTES,
          );
          if (buildKitReclaimed > 0) {
            log(
              `[deploy] BuildKit cache over ${formatBytes(BUILDKIT_CACHE_MAX_BYTES)}, ` +
                `reclaimed ${formatBytes(buildKitReclaimed)}`,
            );
          }
        } catch (err) {
          // Logged rather than swallowed: buildctl is deprecating
          // --keep-storage, and a silent failure reads exactly like a cache
          // that never needed pruning.
          log(`[deploy] BuildKit cache prune failed: ${err instanceof Error ? err.message : err}`);
        }
      } finally {
        await releaseLock(PRUNE_LOCK_KEY).catch(() => {});
      }
    }
  } catch {
    // Image pruning is best-effort
  }

  ctx.stage("cleanup", "success");

  // Closes the deploy stream. It goes after the write so a client that reloads
  // on this event reads the finished row rather than racing it.
  ctx.stage("done", "success");

  // The three below announce the success row above. A dropped announcement
  // leaves nothing running, so none of them is post-deploy work left unfinished.
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

  sendDeployNotification(app, ctx.deploymentId, true, durationMs).catch(() => {});

  // Whatever was held from before the commit lands here, behind the success.
  for (const reason of pendingUnfinished.splice(0)) {
    await recordPostDeployIncomplete(ctx, reason);
  }

  // Execute after.deploy.success hooks — plugins handle backup, security scan,
  // rollback monitor, drift check, and any user-registered hooks.
  try {
    const { executeHooks } = await import("@/lib/hooks/execute");
    const hookResult = await executeHooks("after.deploy.success", {
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

    // A failing after.* hook returns rather than throws — backup, security scan
    // and the rollback monitor all hang off this event.
    if (!hookResult.allowed) {
      const { hookName, reason } = hookResult.blockedBy ?? {};
      await unfinishedWork(`the "${hookName ?? "after.deploy.success"}" hook failed — ${reason ?? "no reason given"}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[deploy] Warning: post-deploy hooks — ${message}`);
    await unfinishedWork(`the after.deploy.success hooks did not run — ${message}`);
  }

  // Auto-rollback watches from inside Vardo, so it cannot watch Vardo: the
  // watcher dies with the slot it would replace. Say so rather than let the
  // app's setting imply cover it does not have.
  if (app.autoRollback && isSelfApp(app.name) && activeSlot) {
    log(
      `[deploy] Auto-rollback is not armed for Vardo itself — use instant rollback (${activeSlot} is a warm standby) if this release misbehaves`,
    );
  }

  // The old slot is running this process, so this stop ends the deploy. It goes
  // last, after every write above is durable. Anything that throws earlier
  // leaves the old slot serving alongside the new one.
  if (ctx.stopOldSlot && ctx.stopOldSlotEndsDeploy) {
    // Hand back the concurrency slot first — the `finally` that normally does it
    // never runs. Skipped when another deploy is queued behind us, which would
    // otherwise start inside the process about to be stopped. A queue check that
    // throws must not skip the stop below.
    if (await isDeployQueueDrained().catch(() => false)) {
      await releaseConcurrencySlot(ctx.deploymentId).catch(() => {});
    }
    log(`[deploy] Stopping the slot running this deploy — ${newSlot} is serving`);
    await stopOldSlot();
  }

  return ctx;
}
