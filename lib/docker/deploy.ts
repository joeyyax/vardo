import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps, organizations, environments, projects, domains } from "@/lib/db/schema";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { eq, and, inArray, isNotNull, ne } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { nanoid } from "nanoid";
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
import { DeployBlockedError } from "./errors";
import { assertSlotWithinApp } from "./slot-guard";
import { assertDiskHeadroom } from "./disk-guard";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { createDeployLogger, DEPLOY_STAGE_ORDER } from "./deploy-logger";
import { recordPostDeployIncomplete } from "./deploy-incomplete";
import type { DeployStage } from "./deploy-logger";
import type { DeployContext } from "./deploy-context";
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
import { createStageTimings, formatTimings, STAGE_PHASE } from "./stage-timings";

export type { DeployStage } from "./deploy-logger";

export type DeployOpts = {
  appId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
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
};

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
};

export async function createDeployment(opts: DeployOpts): Promise<string> {
  const [deployment] = await db
    .insert(deployments)
    .values({
      id: nanoid(),
      appId: opts.appId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      status: "queued",
      environmentId: opts.environmentId,
      groupEnvironmentId: opts.groupEnvironmentId,
    })
    .returning({ id: deployments.id });

  return deployment.id;
}

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
    const snapshot = logLines.join("\n");
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
    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deploymentId));

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
      with: { domains: true },
    });

    if (!app) throw new Error("App not found");

    // Child-service domains, tagged with their compose service for label injection.
    const childDomains = await db.query.domains.findMany({
      where: inArray(
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
      ),
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
      columns: { id: true, name: true, baseDomain: true, trusted: true, isSystemManaged: true },
    });
    const orgTrusted = org?.trusted ?? false;

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

    // Local environments always allow bind mounts. The Docker socket stays on the project flag (#803).
    if (envType === "local") {
      projectAllowBindMounts = true;
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

    streamLogger.addSecrets(Object.values(envMap));
    const totalEnvVarCount = Object.keys(envMap).length;
    if (app.containerPort && !envMap.PORT) {
      envMap.PORT = String(app.containerPort);
    }
    log(`[deploy] ${totalEnvVarCount} env var(s), ${app.domains.length} domain(s)`);

    ctx = {
      deploymentId,
      appId: opts.appId,
      organizationId: opts.organizationId,
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy,
      environmentId: opts.environmentId,
      groupEnvironmentId: opts.groupEnvironmentId,
      signal: opts.signal,
      rollback: rollbackTarget
        ? { targetDeploymentId: rollbackTarget.targetDeploymentId, gitSha: rollbackTarget.gitSha }
        : undefined,

      app: app as DeployContext["app"],
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
      stage,
      checkAbort,
      timer,
      logs,
      logLines,
      startTime,
    };

    await assertDiskHeadroom();

    // Each step reads and mutates ctx.
    ctx = await prepareRepo(ctx);
    ctx.projectNetwork = await prepareProjectNetwork(ctx);
    ctx = await resolveCompose(ctx);
    ctx = await build(ctx);
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

    // Cut over and serving; only post-deploy work failed. Row, status and stream stand.
    if (ctx?.succeeded) {
      await recordPostDeployIncomplete(ctx, message);
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

    // Superseded or killed.
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason as { supersededBy?: string; killed?: boolean } | undefined;
      const supersededById = reason?.supersededBy;

      if (supersededById) {
        // The superseding deploy owns apps.status.
        log(`[deploy] Superseded by deployment ${supersededById}`);
        fail();
        await db
          .update(deployments)
          .set({
            status: "superseded",
            supersededBy: supersededById,
            log: logLines.join("\n"),
            durationMs,
            finishedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId));

        addEvent(opts.organizationId, {
          type: "deploy.status",
          title: "Deploy superseded",
          message: `Deployment ${deploymentId} superseded by ${supersededById}`,
          appId: opts.appId,
          deploymentId,
          status: "superseded",
          success: false,
          supersededBy: supersededById,
        }).catch(() => {});

        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "superseded" };
      }

      if (reason?.killed) {
        log(`[deploy] Cancelled by user`);
        fail();
        await db
          .update(deployments)
          .set({
            status: "cancelled",
            log: logLines.join("\n"),
            durationMs,
            finishedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId));

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

        await streamLogger.flush();
        return { deploymentId, success: false, log: logLines.join("\n"), durationMs, status: "cancelled" };
      }
    }

    log(`[deploy] ERROR: ${message}`);
    const failedTimings = formatTimings(timer.snapshot());
    if (failedTimings) log(failedTimings);

    // Past the deploy stage containers may be running. Nothing here has committed.
    const CONTAINER_STAGES: Set<DeployStage> = new Set(["deploy", "healthcheck", "routing", "cleanup", "done"]);
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
    await db
      .update(deployments)
      .set({ status: "failed", log: logLines.join("\n"), stageTimings: timer.snapshot(), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    if (ownsAppStatus) {
      await db
        .update(apps)
        .set(statusChange(keptNewSlot ? "active" : "error"))
        .where(eq(apps.id, opts.appId));
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

    sendDeployNotification(
      { id: opts.appId, name: "", displayName: "", organizationId: opts.organizationId, domains: [] },
      deploymentId, false, durationMs, message
    ).catch(() => {});

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

export async function sendDeployNotification(
  app: { id: string; name: string; displayName: string; organizationId?: string; domains: { domain: string }[] },
  deploymentId: string,
  success: boolean,
  durationMs: number,
  errorMessage?: string,
) {
  try {
    if (!app.organizationId) return;
    const { emit } = await import("@/lib/notifications/dispatch");
    const deployment = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId), columns: { gitSha: true, gitMessage: true, triggeredBy: true } });
    let triggeredByName: string | undefined;
    if (deployment?.triggeredBy) { const { user: userTable } = await import("@/lib/db/schema"); const u = await db.query.user.findFirst({ where: eq(userTable.id, deployment.triggeredBy), columns: { name: true, email: true } }); triggeredByName = u?.name || u?.email || undefined; }
    const duration = durationMs < 1000 ? `${durationMs}ms` : `${Math.round(durationMs / 1000)}s`;
    const domain = app.domains[0]?.domain;
    const projectName = app.displayName || app.name;

    if (success) {
      emit(app.organizationId, {
        type: "deploy.success",
        title: `Deploy successful: ${projectName}`,
        message: `${projectName} was deployed successfully in ${duration}.`,
        projectName,
        appId: app.id,
        deploymentId,
        duration,
        domain,
        gitSha: deployment?.gitSha ?? undefined,
        gitMessage: deployment?.gitMessage ?? undefined,
        triggeredBy: triggeredByName,
      });
    } else {
      emit(app.organizationId, {
        type: "deploy.failed",
        title: `Deploy failed: ${projectName}`,
        message: errorMessage || "Deployment failed with an unknown error.",
        projectName,
        appId: app.id,
        deploymentId,
        domain,
        gitSha: deployment?.gitSha ?? undefined,
        gitMessage: deployment?.gitMessage ?? undefined,
        triggeredBy: triggeredByName,
        errorMessage,
      });
    }
  } catch (err) { logger.child("notifications").error("Deploy notification error:", err); }
}

export async function deployProject(opts: DeployOpts): Promise<DeployResult> {
  const deploymentId = await createDeployment(opts);
  return runDeployment(deploymentId, opts);
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
    try {
      const args = ["compose", ...composeFileArgs, "-p", project, "down"];
      if (removeVolumes) {
        args.push("--volumes");
      }
      const { stdout, stderr } = await execFileAsync("docker", args, { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT });
      if (stdout.trim()) logs.push(stdout.trim());
      if (stderr.trim()) logs.push(stderr.trim());
    } catch (err) {
      logs.push(`Warning: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      try {
        const { readdir } = await import("fs/promises");
        const entries = await readdir(baseDir, { withFileTypes: true });
        const envDirs = entries.filter((e) => e.isDirectory() && e.name !== "repo");
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
      } catch {
        // Legacy layout.
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

