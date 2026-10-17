import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps, organizations, environments, projects, domains } from "@/lib/db/schema";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { eq, and, inArray, isNotNull, ne, desc } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { addEvent } from "@/lib/stream/producer";
import { readlink } from "fs/promises";
import { join } from "path";
import { appBaseDir, appEnvDir } from "@/lib/paths";
import { assertAppDirOwnership } from "./app-dir-owner";
import {
  slotComposeFiles,
} from "./compose";
import { detectActiveSlot } from "./slots";
import { pointCurrentAt } from "./active-slot";
import { sharedProjectName } from "./slot-partition";
import { readSlotPartition } from "./shared-project";
import { recordActivity } from "@/lib/activity";
import { DeployBlockedError, DeployClosedElsewhereError } from "./errors";
import { NeedsLocalDeploySlotError, type DeploySlot } from "./build-gate";
import { assertSlotWithinApp } from "./slot-guard";
import { assertDiskHeadroom } from "./disk-guard";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { createDeployLogger, DEPLOY_STAGE_ORDER } from "./deploy-logger";
import { recordPostDeployIncomplete } from "./deploy-incomplete";
import type { DeployStage } from "./deploy-logger";
import { savedLog, type DeployContext } from "./deploy-context";
import {
  COMPOSE_DOWN_TIMEOUT,
  COMPOSE_RESTART_TIMEOUT,
  ENDPOINT_CHECK_TIMEOUT,
} from "./constants";
import { prepareRepo, resolveCompose, build, swap, postDeploy } from "./deploy-steps";
import { prepareProjectNetwork } from "./project-network-sync";
import { resolveDeployEnv, resolveDefaultEnv } from "./resolve-env";
import {
  loadRollbackTarget,
  applyRollbackTarget,
  applyRollbackEnv,
  type RollbackTarget,
} from "./rollback-target";
import { execFileAsync } from "@/lib/utils/exec";
import { splitRoutable } from "@/lib/domains/routable";
import { environmentDomains, withoutEnvironmentHosts } from "./environment-domains";
import { loadEnvironmentEnv } from "./environment-env";
import { productionHostRefs } from "@/lib/env/environment-env";
import { dockerEnv } from "@/lib/docker/docker-env";
import { createStageTimings, formatTimings, STAGE_PHASE, timedWait, type StageTimings } from "./stage-timings";
import type { RebuildMode } from "./build-key";
import { crashReason, relevantLogTail } from "./deploy-log-tail";
import { resolveRebuild, buildCacheLogLine } from "./build-key";
import { repoWebUrl } from "@/lib/email/format";
import { recordSelfDeploy, type MarkerOutcome } from "@/lib/lifecycle/self-deploy";
import { deployIncident } from "@/lib/incidents/deploy";

export type { DeployStage } from "./deploy-logger";

/** Past the deploy stage containers may be running. Nothing here has committed. */
const CONTAINER_STAGES: ReadonlySet<DeployStage> = new Set(["deploy", "healthcheck", "routing", "cleanup", "done"]);

/** Records a deploy of Vardo itself in the update marker. A no-op for every other app. */
export function recordSelfUpdate(ctx: DeployContext | null | undefined, outcome: MarkerOutcome, opts?: { marker?: boolean }): Promise<void> {
  if (!ctx?.app) return Promise.resolve();
  return recordSelfDeploy(
    {
      deploymentId: ctx.deploymentId,
      appId: ctx.appId,
      appName: ctx.app.name,
      envIsolated: ctx.envIsolated === true,
      envType: ctx.envType,
      startTime: ctx.startTime,
      activeSlot: ctx.activeSlot,
      newSlot: ctx.newSlot,
      gitSha: ctx.gitSha,
      gitBranch: ctx.envBranchOverride ?? ctx.app.gitBranch,
      repoDir: ctx.repoDir,
      slotDir: ctx.slotDir,
      oldStoppedAt: ctx.oldStoppedAt,
      healthyAt: ctx.healthyAt,
      logLines: ctx.logLines,
    },
    outcome,
    opts,
  );
}

export type DeployOpts = {
  appId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback" | "relay" | "poll";
  triggeredBy?: string;
  environmentId?: string;
  groupEnvironmentId?: string;
  onLog?: (line: string) => void;
  onStage?: (stage: DeployStage, status: "running" | "success" | "failed" | "skipped") => void;
  signal?: AbortSignal;
  /** Pre-created deployment record; skips createDeployment. */
  deploymentId?: string;
  /** Redeploy a previous deployment's git SHA, config snapshot and optionally env snapshot. */
  rollback?: { targetDeploymentId: string; includeEnvVars?: boolean };
  /** Deploy this commit of the branch, not its tip. Git apps only. */
  gitSha?: string;
  /** Where `gitSha` came from: the commit a push named, or one someone chose. Defaults to "pin". */
  pinIntent?: "push" | "pin";
  /** Build even when an earlier image matches; "no-cache" skips the layer cache too. */
  rebuild?: RebuildMode;
  /** Executor holding the row's claim. Every write that ends the row requires it. */
  executorId?: string;
  /** Checked before the swap touches containers, and records the swap stage. False stops the deploy. */
  fence?: () => Promise<boolean>;
  /** The deploy slot its claim took. */
  deploySlot?: DeploySlot;
};

/** Why an executor aborted a run. */
export type DeployAbortReason =
  | { superseded: true; supersededBy?: string }
  | { killed: true; reason: "user" | "timeout" }
  | { lost: true };

/** The row while this run still owns it: claimed by its executor, or in progress for a run without one. */
export function ownedRow(deploymentId: string, executorId?: string) {
  return executorId
    ? and(eq(deployments.id, deploymentId), eq(deployments.status, "running"), eq(deployments.claimedBy, executorId))
    : and(eq(deployments.id, deploymentId), inArray(deployments.status, ["queued", "running"]));
}

export type DeployResult = {
  deploymentId: string;
  success: boolean;
  log: string;
  durationMs: number;
  /** Terminal state of the run. */
  status: "success" | "failed" | "cancelled" | "superseded";
  /** Failure message, set only when status is "failed". */
  error?: string;
  /** Post-deploy work that did not finish on a deploy that succeeded. */
  postDeployError?: string;
  /** Another process, such as the sweeper, closed the row first and reported it. */
  closedElsewhere?: boolean;
};

/** The app's production hostnames and those of the other apps in its project. */
async function productionHostsFor(
  appId: string,
  projectId: string | null,
  appDomains: { domain: string }[],
  environmentHost: string | null,
): Promise<string[]> {
  const hosts = new Set(appDomains.map((d) => d.domain));
  if (projectId) {
    const siblings = await db.query.domains.findMany({
      where: inArray(
        domains.appId,
        db.select({ id: apps.id }).from(apps).where(and(eq(apps.projectId, projectId), ne(apps.id, appId))),
      ),
      columns: { domain: true },
    });
    for (const d of siblings) hosts.add(d.domain);
  }
  if (environmentHost) hosts.delete(environmentHost);
  return [...hosts];
}

export async function runDeployment(
  deploymentId: string,
  opts: DeployOpts
): Promise<DeployResult> {
  // Execution clock for durationMs. Time before this is queue wait.
  const startTime = Date.now();
  const logLines: string[] = [];
  // The row's log from before this run, read when the run confirms its claim.
  let logPrefix: string | undefined;
  const saved = () => savedLog({ logLines, logPrefix });

  // Redis Stream logger (persistent, replayable).
  const streamLogger = createDeployLogger(deploymentId);

  function log(line: string) {
    const sanitized = streamLogger.log(line);
    logLines.push(sanitized);
    opts.onLog?.(sanitized);
    return sanitized;
  }

  const timer = createStageTimings();

  // Serialized so a slow write can't land after a later one and shorten the log.
  let logFlush: Promise<unknown> = Promise.resolve();

  /** Persist the log so far, so a process that dies mid-deploy keeps it. */
  function flushLog() {
    const snapshot = saved();
    const stageTimings = timer.snapshot();
    logFlush = logFlush
      .then(() =>
        db
          .update(deployments)
          .set({ log: snapshot, stageTimings })
          .where(eq(deployments.id, deploymentId)),
      )
      .catch(() => {});
  }

  type StageStatus = "running" | "success" | "failed" | "skipped";
  const stageStatus = new Map<DeployStage, StageStatus>();

  function emitStage(s: DeployStage, status: StageStatus) {
    stageStatus.set(s, status);
    const phase = STAGE_PHASE[s];
    if (phase) {
      if (status === "running") timer.begin(phase);
      else timer.end(phase);
    }
    opts.onStage?.(s, status);
    streamLogger.stage(s, status);
    flushLog();
  }

  function stage(s: DeployStage, status: StageStatus) {
    // Close a phase a step left open, or the progress header spins on it.
    const reached = DEPLOY_STAGE_ORDER.indexOf(s);
    if (reached > 0) {
      for (const earlier of DEPLOY_STAGE_ORDER.slice(0, reached)) {
        if (stageStatus.get(earlier) === "running") emitStage(earlier, "success");
      }
    }
    emitStage(s, status);
  }

  /** The phase in flight, or null between phases. */
  function runningStage(): DeployStage | null {
    return DEPLOY_STAGE_ORDER.findLast((s) => stageStatus.get(s) === "running") ?? null;
  }

  /** How far the deploy got. */
  function reachedStage(): DeployStage {
    return DEPLOY_STAGE_ORDER.findLast((s) => stageStatus.has(s)) ?? "queued";
  }

  /** The phase the deploy was about to enter. */
  function pendingStage(): DeployStage {
    return DEPLOY_STAGE_ORDER.at(DEPLOY_STAGE_ORDER.indexOf(reachedStage()) + 1) ?? "done";
  }

  function checkAbort() {
    if (opts.signal?.aborted) throw new Error("Deployment aborted");
  }

  const logs = { push: log };

  let ctx: DeployContext | undefined;

  // apps.status describes the default environment; set once this deploy is that.
  let ownsAppStatus = false;

  try {
    // A claimed row is already running; without an executor, only while still queued.
    const [claimed] = opts.executorId
      ? await db.select({ log: deployments.log }).from(deployments).where(ownedRow(deploymentId, opts.executorId))
      : await db
          .update(deployments)
          .set({ status: "running" })
          .where(and(eq(deployments.id, deploymentId), eq(deployments.status, "queued")))
          .returning({ log: deployments.log });
    logPrefix = claimed?.log ?? undefined;
    if (!claimed) {
      log("[deploy] Not started: the deployment was closed while it waited in the queue");
      await streamLogger.flush();
      return { deploymentId, success: false, log: logLines.join("\n"), durationMs: 0, status: "cancelled", closedElsewhere: true };
    }
    if (opts.deploySlot?.note) log(opts.deploySlot.note);

    if (opts.groupEnvironmentId && !opts.environmentId) {
      throw new DeployBlockedError("Group environment deploy without an app environment — refusing to deploy production");
    }

    // Defaults to production.
    if (!opts.environmentId) {
      const defaultEnv = await db.query.environments.findFirst({
        where: and(
          eq(environments.appId, opts.appId),
          eq(environments.isDefault, true),
        ),
        columns: { id: true },
      });
      if (defaultEnv) opts.environmentId = defaultEnv.id;
    }

    const resolvedEnv = await resolveDeployEnv(opts.appId, opts.environmentId);
    const envName = resolvedEnv.name;
    const envType = resolvedEnv.type;
    const envBranchOverride = resolvedEnv.gitBranch;
    log(`[deploy] Environment: ${envName} (${envType})`);

    if (envType === "preview" && !(await isFeatureEnabledAsync("previews"))) {
      throw new DeployBlockedError("Previews are disabled on this instance");
    }

    ownsAppStatus = !!resolvedEnv.isDefault;

    // The deploy owns the app status until it exits; the sweeper resets it if this process dies.
    if (ownsAppStatus) {
      await db
        .update(apps)
        .set(statusChange("deploying"))
        .where(eq(apps.id, opts.appId));
    }

    addEvent(opts.organizationId, {
      type: "deploy.status",
      title: "Deploy started",
      message: `Deployment ${deploymentId} started`,
      appId: opts.appId,
      deploymentId,
      status: "running",
      success: false,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.started",
      appId: opts.appId,
      userId: opts.triggeredBy,
      metadata: { deploymentId, trigger: opts.trigger },
    }).catch(() => {});

    log(`[deploy] Starting deployment ${deploymentId}`);

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, opts.appId),
        eq(apps.organizationId, opts.organizationId)
      ),
      // Compose rows describe the app's own labels; Vardo routes only its managed ones.
      with: { domains: { where: eq(domains.source, "vardo") } },
    });

    if (!app) throw new Error("App not found");

    // Child-service domains, tagged with their compose service for label injection.
    const childDomains = await db.query.domains.findMany({
      where: and(eq(domains.source, "vardo"), inArray(
        domains.appId,
        db
          .select({ id: apps.id })
          .from(apps)
          .where(
            and(
              eq(apps.parentAppId, app.id),
              eq(apps.organizationId, opts.organizationId),
            ),
          ),
      )),
      with: {
        app: { columns: { composeService: true } },
      },
    });
    for (const d of childDomains) {
      app.domains.push({
        ...d,
        serviceName: d.app?.composeService ?? d.serviceName,
      } as typeof app.domains[number]);
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, opts.organizationId),
      columns: { id: true, name: true, slug: true, baseDomain: true, trusted: true, isSystemManaged: true, memoryProfile: true },
    });
    const orgTrusted = org?.trusted ?? false;
    const projectRow = app.projectId
      ? await db.query.projects.findFirst({ where: eq(projects.id, app.projectId), columns: { name: true } })
      : null;
    streamLogger.addPublicNames([
      app.name, app.displayName, projectRow?.name, org?.name, org?.slug, org?.baseDomain, ...app.domains.map((d) => d.domain),
    ]);

    // Per-project bind mount and Docker socket permissions.
    let projectAllowBindMounts = false;
    let projectAllowDockerSocket = false;
    if (orgTrusted) {
      projectAllowBindMounts = true;
      projectAllowDockerSocket = true;
    } else if (app.projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, app.projectId),
        columns: { allowBindMounts: true, allowDockerSocket: true },
      });
      projectAllowBindMounts = project?.allowBindMounts ?? false;
      projectAllowDockerSocket = project?.allowDockerSocket ?? false;
    }

    // Hostnames a non-default environment's env must not point at.
    const productionHosts = resolvedEnv.isDefault
      ? []
      : await productionHostsFor(app.id, app.projectId, app.domains, resolvedEnv.domain);

    if (resolvedEnv.isDefault) {
      const groupEnvHosts = await db.query.environments.findMany({
        where: and(
          eq(environments.appId, opts.appId),
          eq(environments.isDefault, false),
          isNotNull(environments.groupEnvironmentId),
        ),
        columns: { domain: true },
      });
      app.domains = withoutEnvironmentHosts(app.domains, groupEnvHosts.map((e) => e.domain));
    } else {
      app.domains = environmentDomains(app.domains, resolvedEnv, app.id);
    }

    // Hosts the org hasn't proved it owns, the console's host and the instance base domain don't route (#891).
    if (org) {
      const { routable, dropped } = await splitRoutable(app.domains, org);
      for (const d of dropped) log(`[deploy] Domain ${d.domain} not routed: not verified for this organization, or reserved`);
      app.domains = routable;
    }

    stage("clone", "running");
    log(`[deploy] App: ${app.displayName} (${app.name})`);
    log(`[deploy] Source: ${app.source}, Type: ${app.deployType}`);

    // Overlay the rollback target's snapshot before anything reads the app. Throws when it can't be deployed.
    let rollbackTarget: RollbackTarget | null = null;
    if (opts.rollback) {
      rollbackTarget = await loadRollbackTarget(
        opts.appId,
        opts.rollback.targetDeploymentId,
        opts.rollback.includeEnvVars ?? false,
      );
      applyRollbackTarget(app as DeployContext["app"], rollbackTarget, log);
      applyRollbackEnv(app as DeployContext["app"], rollbackTarget, log);
    }

    // A non-default environment uses its own env, or the app's when it predates snapshots.
    let envFromApp = true;
    if (!resolvedEnv.isDefault && resolvedEnv.id && !(rollbackTarget?.includeEnvVars && rollbackTarget.envSnapshot)) {
      const own = await loadEnvironmentEnv(resolvedEnv.id);
      if (own !== null) {
        app.envContent = own;
        envFromApp = false;
      } else if (envType === "preview") {
        throw new DeployBlockedError(`Preview ${envName} has no env of its own, and previews never deploy with production's. Recreate the preview.`);
      } else {
        log(`[deploy] Warning: environment ${envName} has no env of its own — deploying with the app's env`);
      }
    }

    const envMap: Record<string, string> = {};
    if (app.envContent) {
      const { content: envText, wasEncrypted, decryptFailed } = decryptOrFallback(
        app.envContent,
        app.organizationId,
      );
      // Never deploy with no env: most apps boot on defaults, pass healthcheck and take the cutover.
      if (decryptFailed) {
        throw new DeployBlockedError(
          `Could not decrypt this app's environment variables — check ENCRYPTION_MASTER_KEY. ` +
            `Refusing to deploy without them.`,
        );
      }
      if (envText) {
        Object.assign(envMap, parseEnvToMap(envText));
        if (!wasEncrypted && envFromApp) {
          log("[deploy] Warning: env vars were not encrypted — auto-encrypting");
          try {
            const { encrypt } = await import("@/lib/crypto/encrypt");
            await db.update(apps)
              .set({ envContent: encrypt(envText, app.organizationId) })
              .where(eq(apps.id, app.id));
          } catch { /* best-effort */ }
        }
      }
    }

    for (const { key, host } of productionHostRefs(envMap, productionHosts)) {
      log(`[deploy] Warning: ${key} points at production's ${host}`);
    }

    streamLogger.addSecrets(envMap);
    const totalEnvVarCount = Object.keys(envMap).length;
    if (app.containerPort && !envMap.PORT) {
      envMap.PORT = String(app.containerPort);
    }
    log(`[deploy] ${totalEnvVarCount} env var(s), ${app.domains.length} domain(s)`);
    const rebuild = resolveRebuild(opts.rebuild, app.buildCache, Boolean(rollbackTarget));
    const cacheLine = buildCacheLogLine(rebuild, app.buildCache, opts.rebuild);
    if (cacheLine) log(cacheLine);

    ctx = {
      deploymentId,
      appId: opts.appId,
      organizationId: opts.organizationId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      environmentId: opts.environmentId,
      groupEnvironmentId: opts.groupEnvironmentId,
      signal: opts.signal,
      claimedBy: opts.executorId,
      fence: opts.fence,
      deploySlot: opts.deploySlot,
      rollback: rollbackTarget
        ? { targetDeploymentId: rollbackTarget.targetDeploymentId, gitSha: rollbackTarget.gitSha }
        : undefined,
      rollbackTarget: rollbackTarget ?? undefined,
      pinnedGitSha: rollbackTarget ? undefined : opts.gitSha,
      pinIntent: opts.pinIntent,
      rebuild,

      app: app as DeployContext["app"],
      projectName: projectRow?.name,
      org: org ?? null,
      orgTrusted,
      projectAllowBindMounts,
      projectAllowDockerSocket,

      envName,
      envType,
      envBranchOverride,
      envIsolated: !resolvedEnv.isDefault,
      envMap,

      volumesList: [],
      appVolumes: [],
      effectiveSource: app.source,

      compose: { services: {} },
      bareCompose: { services: {} },
      serviceConfig: {},
      builtLocally: false,
      builtImageRefs: [],
      hostConfig: null,
      repoDir: null,

      appBase: "",
      appDir: "",
      slotDir: "",
      newProjectName: "",
      activeSlot: null,
      newSlot: "blue",
      isLocalEnv: envType === "local",
      containerPort: 0,
      composeFileArgs: [],
      stableVolumePrefix: "",

      log,
      addSecrets: streamLogger.addSecrets,
      wait: timedWait(timer, streamLogger.wait),
      stage,
      checkAbort,
      timer,
      logs,
      logLines,
      logPrefix,
      startTime,
    };

    await assertDiskHeadroom();

    // Each step reads and mutates ctx.
    ctx = await prepareRepo(ctx);
    // The checkout names the target, so "updating" goes out before the build.
    await recordSelfUpdate(ctx, { state: "started" }, { marker: false });
    ctx.projectNetwork = await prepareProjectNetwork(ctx);
    ctx = await resolveCompose(ctx);
    ctx = await build(ctx);
    // Built and about to start a second console: the point install.sh calls an update started.
    await recordSelfUpdate(ctx, { state: "started" });
    ctx = await swap(ctx);
    ctx = await postDeploy(ctx);

    const timingLine = formatTimings(timer.snapshot());
    if (timingLine) log(timingLine);
    flushLog();
    const durationMs = Date.now() - startTime;
    await streamLogger.flush();
    return { deploymentId, success: true, log: logLines.join("\n"), durationMs, status: "success" };
  } catch (error) {
    // Redacted once: this message reaches events, activity, notifications and the API response.
    const message = streamLogger.redact(error instanceof Error ? error.message : "Unknown error");
    const durationMs = Date.now() - startTime;
    timer.endAll();

    // A hold left by a failure after the health check pins the old slot; drop it.
    if (ctx?.releaseHold) {
      await ctx.releaseHold().catch(() => {});
      ctx.releaseHold = undefined;
    }

    // Back in the queue for this server's deploy slot; the next claim runs it from the start.
    if (error instanceof NeedsLocalDeploySlotError && opts.executorId && !opts.signal?.aborted) {
      log("[queue] Back in the queue: this build runs only on this server, and its deploy slots are full");
      const { requeueForLocalSlot } = await import("@/lib/deploy/queue");
      if (await requeueForLocalSlot(opts.executorId, deploymentId, saved())) {
        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "cancelled", closedElsewhere: true };
      }
    }

    // The sweeper closed the row and reported it; the step already dropped the new slot.
    if (error instanceof DeployClosedElsewhereError) {
      log(`[deploy] Stopped: ${error.message}. The old slot keeps serving`);
      stage(runningStage() ?? pendingStage(), "failed");
      await streamLogger.flush();
      return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "cancelled", closedElsewhere: true };
    }

    // Cut over and serving; only post-deploy work failed. Row, status and stream stand.
    if (ctx?.succeeded) {
      await recordPostDeployIncomplete(ctx, message);
      await recordSelfUpdate(ctx, { state: "updated", finishedAt: Date.now() });
      await streamLogger.flush();
      return {
        deploymentId,
        success: true,
        log: logLines.join("\n"),
        durationMs,
        status: "success",
        postDeployError: message,
      };
    }

    // Every exit below closes the stream with a failed stage, blamed on the phase in flight or the one that never opened.
    const blamed = runningStage() ?? pendingStage();
    const fail = () => stage(blamed, "failed");

    // Superseded, killed or no longer this executor's.
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason as Partial<{ superseded: true; supersededBy: string; killed: true; reason: string; lost: true }> | undefined;

      if (reason?.lost) {
        log("[deploy] Stopped: this executor lost its claim on the deployment. The old slot keeps serving");
        fail();
        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "cancelled", closedElsewhere: true };
      }

      if (reason?.superseded) {
        const supersededById = reason.supersededBy ?? null;
        // The superseding deploy owns apps.status.
        log(supersededById ? `[deploy] Superseded by deployment ${supersededById}` : "[deploy] Superseded by a newer deploy");
        fail();
        await db
          .update(deployments)
          .set({
            status: "superseded",
            supersededBy: supersededById,
            log: saved(),
            durationMs,
            finishedAt: new Date(),
          })
          .where(ownedRow(deploymentId, opts.executorId));

        addEvent(opts.organizationId, {
          type: "deploy.status",
          title: "Deploy superseded",
          message: supersededById ? `Deployment ${deploymentId} superseded by ${supersededById}` : `Deployment ${deploymentId} superseded`,
          appId: opts.appId,
          deploymentId,
          status: "superseded",
          success: false,
          supersededBy: supersededById ?? undefined,
        }).catch(() => {});

        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "superseded" };
      }

      if (reason?.killed) {
        log(reason.reason === "timeout" ? "[deploy] Cancelled: ran past the deploy time limit" : "[deploy] Cancelled by user");
        fail();
        await db
          .update(deployments)
          .set({
            status: "cancelled",
            log: saved(),
            durationMs,
            finishedAt: new Date(),
          })
          .where(ownedRow(deploymentId, opts.executorId));

        // Guarded so a newer deploy keeps ownership; the reconciler corrects "stopped" from Docker.
        if (ownsAppStatus) {
          await db
            .update(apps)
            .set(statusChange("stopped"))
            .where(and(eq(apps.id, opts.appId), eq(apps.status, "deploying")));
        }

        addEvent(opts.organizationId, {
          type: "deploy.status",
          title: "Deploy cancelled",
          message: `Deployment ${deploymentId} cancelled by user`,
          appId: opts.appId,
          deploymentId,
          status: "cancelled",
          success: false,
          durationMs,
        }).catch(() => {});

        recordActivity({
          organizationId: opts.organizationId,
          action: "deployment.cancelled",
          appId: opts.appId,
          metadata: { deploymentId },
        }).catch(() => {});

        await recordSelfUpdate(ctx, {
          state: "failed",
          finishedAt: Date.now(),
          step: blamed,
          error: "Cancelled",
          rolledBack: CONTAINER_STAGES.has(reachedStage()),
        });

        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "cancelled" };
      }
    }

    log(`[deploy] ERROR: ${message}`);
    const failedTimings = formatTimings(timer.snapshot());
    if (failedTimings) log(failedTimings);

    const slotDir = ctx?.slotDir;
    const newProjectName = ctx?.newProjectName;
    let keptNewSlot = false;
    if (ctx && CONTAINER_STAGES.has(reachedStage()) && slotDir && newProjectName) {
      keptNewSlot = await keepProvenSlot(ctx, reachedStage());
      if (keptNewSlot) {
        log(`[deploy] Keeping ${ctx.newSlot} running — it passed its health check and no other slot is serving`);
        if (!ctx.isLocalEnv && ctx.appDir) {
          await pointCurrentAt(ctx.appDir, ctx.newSlot).catch(() => {});
        }
      } else {
        try {
          const cleanupComposeArgs = await slotComposeFiles(slotDir);
          await execFileAsync(
            "docker",
            ["compose", ...cleanupComposeArgs, "-p", newProjectName, "down", "--remove-orphans"],
            { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
          );
          log(`[deploy] Cleaned up containers after failure`);
        } catch {
          // Best effort.
        }
      }
    }

    fail();
    // A row the sweeper already closed keeps its record and the app status it set.
    const recorded = await db
      .update(deployments)
      .set({ status: "failed", log: saved(), stageTimings: timer.snapshot(), durationMs, finishedAt: new Date() })
      .where(ownedRow(deploymentId, opts.executorId))
      .returning({ id: deployments.id })
      .then((rows) => rows.length > 0);

    if (ownsAppStatus && recorded) {
      await db
        .update(apps)
        .set(statusChange(keptNewSlot ? "active" : "error"))
        .where(eq(apps.id, opts.appId));
    }

    if (keptNewSlot) {
      await recordSelfUpdate(ctx, { state: "updated", finishedAt: Date.now() });
    } else {
      await recordSelfUpdate(ctx, {
        state: "failed",
        finishedAt: Date.now(),
        step: blamed,
        error: message,
        rolledBack: CONTAINER_STAGES.has(reachedStage()),
      });
    }

    addEvent(opts.organizationId, {
      type: "deploy.status",
      title: "Deploy failed",
      message: message || `Deployment ${deploymentId} failed`,
      appId: opts.appId,
      deploymentId,
      status: "error",
      success: false,
      durationMs,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.failed",
      appId: opts.appId,
      metadata: { deploymentId, error: message },
    }).catch(() => {});

    sendDeployNotification({
      app: ctx?.app ?? { id: opts.appId, name: "", displayName: "", organizationId: opts.organizationId, domains: [] },
      deploymentId,
      success: false,
      durationMs,
      errorMessage: message,
      ctx,
      trigger: opts.trigger,
      stageTimings: timer.snapshot(),
      failedStage: blamed,
      logLines,
      serving: keptNewSlot ? "new" : undefined,
    }).catch(() => {});

    await streamLogger.flush();
    return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "failed", error: message };
  }
}

/** Stages at which the new slot has passed its health check. */
const PROVEN_STAGES: ReadonlySet<DeployStage> = new Set(["routing", "cleanup", "done"]);

/** Whether a failed deploy must leave its new slot running. */
// Invariant: the only healthy slot is never removed. A proven new slot goes only when the old slot still serves.
export async function keepProvenSlot(ctx: DeployContext, reached: DeployStage): Promise<boolean> {
  if (!PROVEN_STAGES.has(reached)) return false;
  if (!ctx.oldSlotServing) return true;
  return !(await ctx.oldSlotServing().catch(() => false));
}

export type DeployNotice = {
  app: { id: string; name: string; displayName: string; organizationId?: string; domains: { domain: string }[]; gitUrl?: string | null; gitBranch?: string | null; projectId?: string | null };
  deploymentId: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  ctx?: DeployContext;
  trigger?: DeployOpts["trigger"];
  stageTimings?: StageTimings;
  /** Stage the deploy failed in. */
  failedStage?: string;
  /** The deploy log so far, already redacted. */
  logLines?: string[];
  serving?: "previous" | "new" | "none";
};

/** What serves a failed deploy's environment: a newer successful deploy, or nothing. */
async function servingAfterFailure(appId: string, deploymentId: string, environmentId: string | null): Promise<"previous" | "none"> {
  const previous = await db.query.deployments.findFirst({
    where: and(
      eq(deployments.appId, appId),
      eq(deployments.status, "success"),
      ne(deployments.id, deploymentId),
      ...(environmentId ? [eq(deployments.environmentId, environmentId)] : []),
    ),
    columns: { id: true },
  });
  return previous ? "previous" : "none";
}

/** Recent successful deploys "usual" needs before it shows. */
const USUAL_MIN_SAMPLES = 3;

/** Whether this is the app's first successful production deploy, and its median recent duration. */
async function successHistory(
  appId: string,
  deploymentId: string,
  environmentId: string | null,
): Promise<{ firstDeploy: boolean; usualDurationMs?: number }> {
  const rows = await db.query.deployments.findMany({
    where: and(
      eq(deployments.appId, appId),
      eq(deployments.status, "success"),
      ne(deployments.id, deploymentId),
      ...(environmentId ? [eq(deployments.environmentId, environmentId)] : []),
    ),
    orderBy: [desc(deployments.startedAt)],
    limit: 10,
    columns: { durationMs: true, trigger: true },
  });
  const env = environmentId
    ? await db.query.environments.findFirst({ where: eq(environments.id, environmentId), columns: { type: true } })
    : null;
  const durations = rows
    .filter((r) => r.trigger !== "rollback" && (r.durationMs ?? 0) > 0)
    .map((r) => r.durationMs!)
    .sort((a, b) => a - b);
  return {
    firstDeploy: rows.length === 0 && (env?.type ?? "production") === "production",
    usualDurationMs: durations.length >= USUAL_MIN_SAMPLES ? durations[Math.floor(durations.length / 2)] : undefined,
  };
}

export async function sendDeployNotification(notice: DeployNotice) {
  const { deploymentId, success, durationMs, errorMessage, ctx } = notice;
  try {
    const organizationId = notice.app.organizationId;
    if (!organizationId) return;
    const { emit } = await import("@/lib/notifications/dispatch");
    const deployment = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: { gitSha: true, gitMessage: true, triggeredBy: true, trigger: true, slot: true, environmentId: true, groupEnvironmentId: true },
    });

    // A deploy that failed before loading its app has no names yet.
    let app = notice.app;
    if (!app.name) {
      const row = await db.query.apps.findFirst({
        where: eq(apps.id, app.id),
        columns: { name: true, displayName: true, gitUrl: true, gitBranch: true, projectId: true },
        with: { domains: { columns: { domain: true } } },
      });
      if (row) app = { ...app, ...row, domains: row.domains };
    }

    let triggeredByName: string | undefined;
    if (deployment?.triggeredBy) { const { user: userTable } = await import("@/lib/db/schema"); const u = await db.query.user.findFirst({ where: eq(userTable.id, deployment.triggeredBy), columns: { name: true, email: true } }); triggeredByName = u?.name || u?.email || undefined; }
    const duration = durationMs < 1000 ? `${durationMs}ms` : `${Math.round(durationMs / 1000)}s`;
    const domainList = app.domains.map((d) => d.domain);
    const displayName = app.displayName || app.name;

    const details = {
      appName: app.name || undefined,
      project: ctx?.projectName,
      projectId: app.projectId ?? undefined,
      environment: ctx?.envName,
      domains: domainList,
      trigger: notice.trigger ?? deployment?.trigger,
      gitAuthor: ctx?.gitAuthor,
      gitBranch: ctx?.envBranchOverride || app.gitBranch || undefined,
      repoUrl: repoWebUrl(app.gitUrl) ?? undefined,
      slot: ctx && !ctx.isLocalEnv ? ctx.newSlot : deployment?.slot ?? undefined,
      previousSlot: ctx?.activeSlot ?? undefined,
      durationMs,
      stageTimings: notice.stageTimings,
    };
    const gitSha = deployment?.gitSha ?? ctx?.gitSha ?? undefined;
    const gitMessage = deployment?.gitMessage ?? ctx?.gitMessage ?? undefined;
    const incident = await deployIncident(
      organizationId,
      { appId: app.id, deploymentId, displayName, environmentId: deployment?.environmentId ?? null },
      success,
    );
    const incidentField = incident ? { incident } : {};

    if (success) {
      const history = await successHistory(app.id, deploymentId, deployment?.environmentId ?? null).catch(() => ({ firstDeploy: false }));
      let recapAt: string | undefined;
      if (history.firstDeploy) {
        const { scheduleRecaps } = await import("@/lib/recaps/tick");
        const due = await scheduleRecaps(app.id, {
          environmentId: deployment?.environmentId ?? null,
          groupEnvironmentId: deployment?.groupEnvironmentId ?? null,
        }).catch((err) => {
          logger.child("recaps").warn(`Scheduling recaps for ${app.id} failed: ${err instanceof Error ? err.message : err}`);
          return undefined;
        });
        recapAt = due?.toISOString();
      }
      emit(organizationId, {
        type: "deploy.success",
        title: `Deploy successful: ${displayName}`,
        message: `${displayName} was deployed successfully in ${duration}.`,
        projectName: displayName,
        appId: app.id,
        deploymentId,
        duration,
        domain: domainList[0],
        gitSha,
        gitMessage,
        triggeredBy: triggeredByName,
        ...history,
        ...(recapAt ? { recapAt } : {}),
        ...details,
        ...incidentField,
      });
    } else {
      const lines = notice.logLines ?? [];
      const serving = notice.serving ?? (await servingAfterFailure(app.id, deploymentId, deployment?.environmentId ?? null).catch(() => undefined));
      emit(organizationId, {
        type: "deploy.failed",
        title: `Deploy failed: ${displayName}`,
        message: errorMessage || "Deployment failed with an unknown error.",
        projectName: displayName,
        appId: app.id,
        deploymentId,
        domain: domainList[0],
        gitSha,
        gitMessage,
        triggeredBy: triggeredByName,
        errorMessage,
        failedStage: notice.failedStage,
        crashReason: crashReason(lines),
        logTail: relevantLogTail(lines),
        serving,
        ...details,
        ...incidentField,
      });
    }
  } catch (err) { logger.child("notifications").error("Deploy notification error:", err); }
}

export async function checkEndpoint(domain: string, logs: { push: (line: string) => void }): Promise<boolean> {
  const paths = ["/healthz", "/health", "/"];
  const timeout = ENDPOINT_CHECK_TIMEOUT;
  const { safeFetch } = await import("@/lib/security/safe-fetch");
  const { getDomainProbePolicy } = await import("@/lib/security/outbound-policy");
  const policy = await getDomainProbePolicy();

  for (const path of paths) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await safeFetch(`https://${domain}${path}`, { signal: controller.signal, policy });
      clearTimeout(timer);
      if (res.ok) {
        logs.push(`[health] ${domain}${path} → ${res.status}`);
        return true;
      }
    } catch { /* next path */ }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await safeFetch(`http://${domain}/`, { signal: controller.signal, policy });
    clearTimeout(timer);
    if (res.ok) return true;
  } catch { /* not reachable */ }

  return false;
}

/** Active slot dir and compose project. Local envs use `local/`; blue-green reads `current`, defaulting to "blue". */
async function resolveActiveSlot(
  dir: string,
  projectPrefix: string,
): Promise<{ slotDir: string; composeProject: string }> {
  const { access: fsAccess } = await import("fs/promises");
  try {
    await fsAccess(join(dir, "local"));
    // local/ without a current symlink is a local environment.
    try {
      await readlink(join(dir, "current"));
    } catch {
      return {
        slotDir: join(dir, "local"),
        composeProject: projectPrefix,
      };
    }
  } catch {
    // Blue-green.
  }

  // Symlink, then running slot, then legacy file. "blue" when nothing is detectable.
  const activeSlot = (await detectActiveSlot(dir, projectPrefix)) ?? "blue";

  return {
    slotDir: join(dir, activeSlot),
    composeProject: `${projectPrefix}-${activeSlot}`,
  };
}

async function stopSlotInDir(
  dir: string,
  projectPrefix: string,
  logs: string[],
  removeVolumes = false,
  /** App and environment names. Omitted for the legacy unscoped layout. */
  shared?: { appName: string; envName: string; isDefault: boolean },
): Promise<void> {
  const { slotDir, composeProject } = await resolveActiveSlot(dir, projectPrefix);
  const composeFileArgs = await slotComposeFiles(slotDir);

  const down = async (project: string) => {
    const args = ["compose", ...composeFileArgs, "-p", project, "down"];
    if (removeVolumes) {
      args.push("--volumes");
    }
    const { stdout, stderr } = await execFileAsync("docker", args, { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT });
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());
  };

  await down(composeProject);

  // Deploys never take the shared project down, so stop does. Left up, it outlives the app.
  const partition = shared ? await readSlotPartition(slotDir) : null;
  if (shared && partition) {
    // Only the default environment owns the compose `name:`.
    await down(sharedProjectName(shared.appName, shared.envName, shared.isDefault ? partition.composeName : undefined));
  }
}

export async function stopProject(
  appId: string,
  appName: string,
  environmentName?: string,
  removeVolumes = false,
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    // Every path below reaches `docker compose down` through a name-derived directory. Don't move or remove this.
    await assertAppDirOwnership({
      appId,
      appName,
      operation: removeVolumes ? "stop and remove volumes for" : "stop",
    });

    const defaultEnvName = (await resolveDefaultEnv(appId)).name;

    if (environmentName) {
      const envDir = appEnvDir(appName, environmentName);
      await stopSlotInDir(envDir, `${appName}-${environmentName}`, logs, removeVolumes, {
        appName,
        envName: environmentName,
        isDefault: environmentName === defaultEnvName,
      });
    } else {
      // All environments: env-aware layout first.
      const baseDir = appBaseDir(appName);
      const { readdir } = await import("fs/promises");
      const entries = await readdir(baseDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      const envDirs = entries?.filter((e) => e.isDirectory() && e.name !== "repo") ?? [];
      if (envDirs.length > 0) {
        for (const entry of envDirs) {
          // Legacy blue/green dirs at the app root.
          if (entry.name === "blue" || entry.name === "green") {
            await stopSlotInDir(baseDir, appName, logs, removeVolumes);
            break;
          }
          const envDir = join(baseDir, entry.name);
          await stopSlotInDir(envDir, `${appName}-${entry.name}`, logs, removeVolumes, {
            appName,
            envName: entry.name,
            isDefault: entry.name === defaultEnvName,
          });
        }
      } else {
        // Legacy: slot dirs directly under the app.
        await stopSlotInDir(baseDir, appName, logs, removeVolumes);
      }
    }

    // apps.status describes the default environment only.
    if (!environmentName || environmentName === defaultEnvName) {
      const stoppedAt = new Date();
      await db
        .update(apps)
        .set(statusChange("stopped", stoppedAt))
        .where(eq(apps.id, appId));

      // Cascade to compose child services.
      await db
        .update(apps)
        .set(statusChange("stopped", stoppedAt))
        .where(eq(apps.parentAppId, appId));
    }

    return { success: true, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, log: logs.join("\n") };
  }
}

const PREVIEW_ENV_NAME = /^pr-\d+$/;

/** Compose projects a preview teardown may take down: `${app}-pr-<n>-<slot|shared>`. */
export function isPreviewProject(appName: string, envName: string, project: string): boolean {
  if (!PREVIEW_ENV_NAME.test(envName)) return false;
  const prefix = `${appName}-${envName}-`;
  return project.startsWith(prefix) && /^(blue|green|shared)$/.test(project.slice(prefix.length));
}

/**
 * Containers in a compose project that aren't labelled as this app's preview.
 * Each `docker ps` line is `<name>\t<vardo.project.id>\t<vardo.environment>`.
 */
export function foreignPreviewContainers(psOutput: string, appId: string, envName: string): string[] {
  return psOutput
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => {
      const [, id, env] = line.split("\t");
      return id !== appId || env !== envName;
    })
    .map((line) => line.split("\t")[0]);
}

/**
 * Volumes a preview teardown may remove: labelled to the project and named
 * `<project>_<volume>`. An explicit `name:` or `external` volume never qualifies.
 */
export function previewVolumesToRemove(lsOutput: string, project: string): string[] {
  return lsOutput
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.startsWith(`${project}_`) && name.length > project.length + 1);
}

/** Tear down one preview: both slots, its shared project, their project-scoped volumes and its directory. Throws if any `down` fails. */
export async function stopPreviewEnvironment(
  appId: string,
  appName: string,
  envName: string,
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  if (!PREVIEW_ENV_NAME.test(envName)) {
    return { success: false, log: `ERROR: Refusing to tear down "${envName}" — not a preview environment` };
  }
  try {
    await assertAppDirOwnership({ appId, appName, operation: "stop" });

    const envDir = appEnvDir(appName, envName);
    const { access: fsAccess, rm } = await import("fs/promises");
    const exists = (path: string) => fsAccess(path).then(() => true, () => false);
    if (!(await exists(envDir))) {
      return { success: true, log: `Nothing deployed for ${appName}-${envName}` };
    }

    const failures: string[] = [];
    const down = async (project: string, slotDir: string) => {
      if (!isPreviewProject(appName, envName, project)) {
        failures.push(`refused to take down ${project}`);
        return;
      }
      try {
        // A name match isn't proof. Every container must carry this preview's labels.
        const { stdout: ps } = await execFileAsync("docker", [
          "ps", "-a",
          "--filter", `label=com.docker.compose.project=${project}`,
          "--format", '{{.Names}}\t{{.Label "vardo.project.id"}}\t{{.Label "vardo.environment"}}',
        ], { env: dockerEnv(), timeout: 30_000 });
        const foreign = foreignPreviewContainers(ps, appId, envName);
        if (foreign.length > 0) {
          failures.push(`refused to take down ${project}: not labelled as this preview (${foreign.join(", ")})`);
          return;
        }
        // No `-v`: it would also remove volumes with an explicit `name:`, which production can share.
        const args = ["compose", ...(await slotComposeFiles(slotDir)), "-p", project, "down"];
        const { stdout, stderr } = await execFileAsync("docker", args, { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT });
        if (stdout.trim()) logs.push(stdout.trim());
        if (stderr.trim()) logs.push(stderr.trim());

        const { stdout: vols } = await execFileAsync("docker", [
          "volume", "ls", "-q",
          "--filter", `label=com.docker.compose.project=${project}`,
        ], { env: dockerEnv(), timeout: 30_000 });
        const owned = previewVolumesToRemove(vols, project);
        if (owned.length > 0) {
          await execFileAsync("docker", ["volume", "rm", ...owned], { env: dockerEnv(), timeout: 60_000 });
          logs.push(`Removed volumes: ${owned.join(", ")}`);
        }
      } catch (err) {
        failures.push(`${project}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    let sharedFrom: string | null = null;
    for (const slot of ["blue", "green"] as const) {
      const slotDir = join(envDir, slot);
      if (!(await exists(join(slotDir, "docker-compose.yml")))) continue;
      await down(`${appName}-${envName}-${slot}`, slotDir);
      if (!sharedFrom && (await readSlotPartition(slotDir))) sharedFrom = slotDir;
    }
    if (sharedFrom) await down(sharedProjectName(appName, envName), sharedFrom);

    for (const f of failures) logs.push(`ERROR: ${f}`);
    if (failures.length === 0) await rm(envDir, { recursive: true, force: true });
    return { success: failures.length === 0, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, log: logs.join("\n") };
  }
}

export async function restartContainers(
  appName: string,
  environmentName?: string,
  service?: string,
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    const dir = appEnvDir(appName, environmentName);
    const prefix = environmentName
      ? `${appName}-${environmentName}`
      : appName;

    const { slotDir, composeProject } = await resolveActiveSlot(dir, prefix);

    // A missing cwd makes execFile fail with a misleading "spawn docker ENOENT". No slot dir means never deployed.
    const { access: fsAccess } = await import("fs/promises");
    try {
      await fsAccess(slotDir);
    } catch {
      return {
        success: false,
        log: `No deployed compose project found for ${appName} (missing ${slotDir}). Deploy the app to bring it up.`,
      };
    }

    await assertSlotWithinApp({ appName, envName: environmentName ?? "", slotDir, composeProject, reuse: "restart" });
    const composeFileArgs = await slotComposeFiles(slotDir);

    // A shared service has no container in the slot project, where `restart` matches nothing.
    let targetProject = composeProject;
    if (service && environmentName) {
      const partition = await readSlotPartition(slotDir);
      if (partition && service in partition.shared) {
        targetProject = sharedProjectName(appName, environmentName, partition.composeName);
      }
    }

    const restartArgs = ["compose", ...composeFileArgs, "-p", targetProject, "restart"];
    if (service) restartArgs.push(service);

    const { stdout, stderr } = await execFileAsync(
      "docker",
      restartArgs,
      { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT }
    );
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());

    return { success: true, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, log: logs.join("\n") };
  }
}

export async function recreateProject(
  appId: string,
  appName: string,
  environmentName?: string,
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    const dir = appEnvDir(appName, environmentName);
    const prefix = environmentName
      ? `${appName}-${environmentName}`
      : appName;

    const { slotDir, composeProject } = await resolveActiveSlot(dir, prefix);
    await assertSlotWithinApp({ appName, envName: environmentName ?? "", slotDir, composeProject, reuse: "recreate" });
    const composeFileArgs = await slotComposeFiles(slotDir);

    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", composeProject, "up", "-d", "--force-recreate"],
      { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT }
    );
    for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }
    for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }

    // Containers were recreated with fresh env.
    await db
      .update(apps)
      .set({ needsRedeploy: false, updatedAt: new Date() })
      .where(eq(apps.id, appId));

    return { success: true, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, log: logs.join("\n") };
  }
}

