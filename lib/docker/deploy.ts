import { db } from "@/lib/db";
import { statusChange } from "@/lib/db/app-status";
import { deployments, apps, organizations, environments, projects, domains } from "@/lib/db/schema";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { nanoid } from "nanoid";
import { addEvent } from "@/lib/stream/producer";
import { execFile } from "child_process";
import { promisify } from "util";
import { readlink } from "fs/promises";
import { join } from "path";
import { appBaseDir, appEnvDir } from "@/lib/paths";
import { assertAppDirOwnership } from "./app-dir-owner";
import {
  slotComposeFiles,
} from "./compose";
import { detectActiveSlot } from "./slots";
import { sharedProjectName } from "./slot-partition";
import { readSlotPartition } from "./shared-project";
import { recordActivity } from "@/lib/activity";
import { DeployBlockedError } from "./errors";
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
import {
  loadRollbackTarget,
  applyRollbackTarget,
  applyRollbackEnv,
  type RollbackTarget,
} from "./rollback-target";

const execFileAsync = promisify(execFile);

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
  /** Pre-created deployment record ID — if provided, skips createDeployment. */
  deploymentId?: string;
  /**
   * Roll back to a previous deployment: its git SHA, config snapshot and
   * (optionally) env snapshot drive this deploy instead of the app's current row.
   */
  rollback?: { targetDeploymentId: string; includeEnvVars?: boolean };
};

export type DeployResult = {
  deploymentId: string;
  success: boolean;
  log: string;
  durationMs: number;
  /** Terminal state of the run — distinguishes a failure from a cancel or a supersede. */
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

export async function runDeployment(
  deploymentId: string,
  opts: DeployOpts
): Promise<DeployResult> {
  // Execution clock, and the source of durationMs. The row was inserted earlier
  // by createDeployment, so everything before this point is queue wait.
  const startTime = Date.now();
  const logLines: string[] = [];

  // Stream logger — writes to Redis Stream (persistent, replayable)
  const streamLogger = createDeployLogger(deploymentId);

  function log(line: string) {
    const sanitized = streamLogger.log(line);
    logLines.push(sanitized);
    opts.onLog?.(sanitized);
    return sanitized;
  }

  // Serialized so a slow write can't land after a later one and shorten the log.
  let logFlush: Promise<unknown> = Promise.resolve();

  /** Persist the log so far. A process that dies mid-deploy keeps everything up to the last stage. */
  function flushLog() {
    const snapshot = logLines.join("\n");
    logFlush = logFlush
      .then(() =>
        db
          .update(deployments)
          .set({ log: snapshot })
          .where(eq(deployments.id, deploymentId)),
      )
      .catch(() => {});
  }

  type StageStatus = "running" | "success" | "failed" | "skipped";
  const stageStatus = new Map<DeployStage, StageStatus>();

  function emitStage(s: DeployStage, status: StageStatus) {
    stageStatus.set(s, status);
    opts.onStage?.(s, status);
    streamLogger.stage(s, status);
    flushLog();
  }

  function stage(s: DeployStage, status: StageStatus) {
    // A step that opens a phase and returns without closing it would leave the
    // progress header spinning on it for the rest of the deploy.
    const reached = DEPLOY_STAGE_ORDER.indexOf(s);
    if (reached > 0) {
      for (const earlier of DEPLOY_STAGE_ORDER.slice(0, reached)) {
        if (stageStatus.get(earlier) === "running") emitStage(earlier, "success");
      }
    }
    emitStage(s, status);
  }

  /** The phase in flight, or null in the gap between one closing and the next opening. */
  function runningStage(): DeployStage | null {
    return DEPLOY_STAGE_ORDER.findLast((s) => stageStatus.get(s) === "running") ?? null;
  }

  /** How far the deploy got, whatever each phase reported. */
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

  // Build the initial deploy context — fetches app, resolves environment, loads env vars
  let ctx: DeployContext | undefined;

  try {
    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deploymentId));

    // The deploy owns the app status until it exits. The reconciler yields to
    // it, and the sweeper resets it if this process dies mid-deploy.
    await db
      .update(apps)
      .set(statusChange("deploying"))
      .where(eq(apps.id, opts.appId));

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

    // Fetch app
    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, opts.appId),
        eq(apps.organizationId, opts.organizationId)
      ),
      with: { domains: true },
    });

    if (!app) throw new Error("App not found");

    // A domain on a child service is stored against that child app.
    // Aggregate those into the deploy and tag each with its compose service
    // so the injection step can target the right service's container.
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
        // composeService is read by the compose-inject step to decide
        // which service in the rendered compose gets the Traefik labels.
        composeService: d.app?.composeService ?? null,
      } as typeof app.domains[number]);
    }

    // Fetch org — used for trusted flag and env var resolution
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, opts.organizationId),
      columns: { id: true, name: true, baseDomain: true, trusted: true },
    });
    const orgTrusted = org?.trusted ?? false;

    // Resolve per-project bind mount + docker socket permissions
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

    // Resolve environment — default to production if not specified
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

    let envName = "production";
    let envType: "production" | "staging" | "preview" | "local" = "production";
    let envBranchOverride: string | null = null;
    if (opts.environmentId) {
      const env = await db.query.environments.findFirst({
        where: eq(environments.id, opts.environmentId),
        columns: { name: true, type: true, gitBranch: true },
      });
      if (env) {
        envName = env.name;
        envType = env.type;
        envBranchOverride = env.gitBranch;
      }
    }
    log(`[deploy] Environment: ${envName} (${envType})`);

    // Local environments always allow bind mounts + the docker socket
    if (envType === "local") {
      projectAllowBindMounts = true;
      projectAllowDockerSocket = true;
    }

    // Execute before.deploy.start hooks — approval gates, pre-flight checks
    try {
      const { executeHooks } = await import("@/lib/hooks/execute");
      const hookResult = await executeHooks("before.deploy.start", {
        appId: opts.appId,
        appName: app.displayName || app.name,
        organizationId: opts.organizationId,
        deploymentId,
        deployType: app.deployType,
        trigger: opts.trigger,
        triggeredBy: opts.triggeredBy,
      }, {
        organizationId: opts.organizationId,
        appId: opts.appId,
        deployId: deploymentId,
      });

      if (!hookResult.allowed) {
        throw new DeployBlockedError(
          `Blocked by hook "${hookResult.blockedBy?.hookName}": ${hookResult.blockedBy?.reason || "Hook rejected the deploy"}`
        );
      }
    } catch (err) {
      if (err instanceof DeployBlockedError) throw err;
      log(`[deploy] Warning: pre-deploy hooks — ${err instanceof Error ? err.message : err}`);
    }

    stage("clone", "running");
    log(`[deploy] App: ${app.displayName} (${app.name})`);
    log(`[deploy] Source: ${app.source}, Type: ${app.deployType}`);

    // Rollback: overlay the target deployment's snapshot onto the app record
    // before anything reads it. Throws when the target can't be deployed.
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

    // Load env vars from encrypted blob
    const envMap: Record<string, string> = {};
    if (app.envContent) {
      const { content: envText, wasEncrypted } = decryptOrFallback(app.envContent, app.organizationId);
      if (envText) {
        Object.assign(envMap, parseEnvToMap(envText));
        if (!wasEncrypted) {
          log("[deploy] Warning: env vars were not encrypted — auto-encrypting");
          try {
            const { encrypt } = await import("@/lib/crypto/encrypt");
            await db.update(apps)
              .set({ envContent: encrypt(envText, app.organizationId) })
              .where(eq(apps.id, app.id));
          } catch { /* best-effort */ }
        }
      } else if (!wasEncrypted) {
        log("[deploy] Warning: failed to decrypt env vars — check ENCRYPTION_MASTER_KEY");
      }
    }

    const totalEnvVarCount = Object.keys(envMap).length;
    if (app.containerPort && !envMap.PORT) {
      envMap.PORT = String(app.containerPort);
    }
    log(`[deploy] ${totalEnvVarCount} env var(s), ${app.domains.length} domain(s)`);

    // Assemble context for the deploy pipeline
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
      stage,
      checkAbort,
      logs,
      logLines,
      startTime,
    };

    // Run the deploy pipeline — each step reads and mutates ctx
    ctx = await prepareRepo(ctx);
    ctx = await resolveCompose(ctx);
    ctx = await build(ctx);
    ctx = await swap(ctx);
    ctx = await postDeploy(ctx);

    const durationMs = Date.now() - startTime;
    await streamLogger.flush();
    return { deploymentId, success: true, log: logLines.join("\n"), durationMs, status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const durationMs = Date.now() - startTime;

    // The release cut over and is serving; only the tail behind it failed. The
    // row, the app status and the closed stream all stand.
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

    // Every exit from here is terminal, and each one closes the stream with a
    // failed stage — without it the UI waits out its timeout with nothing to show.
    // The failure belongs to the phase in flight, or to the one that never opened.
    const blamed = runningStage() ?? pendingStage();
    const fail = () => stage(blamed, "failed");

    // Check if this deploy was aborted — either superseded by a newer one or killed by the user.
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason as { supersededBy?: string; killed?: boolean } | undefined;
      const supersededById = reason?.supersededBy;

      if (supersededById) {
        // The superseding deploy already owns apps.status — leave it alone.
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

        // Release the app status. Guarded so a deploy that started in the
        // meantime keeps ownership; the reconciler corrects "stopped" from
        // Docker on its next pass.
        await db
          .update(apps)
          .set(statusChange("stopped"))
          .where(and(eq(apps.id, opts.appId), eq(apps.status, "deploying")));

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

    // If we got past the deploy stage, containers may be running — tear them
    // down. A deploy that recorded success returned above, so nothing serving
    // traffic reaches this.
    const CONTAINER_STAGES: Set<DeployStage> = new Set(["deploy", "healthcheck", "routing", "cleanup", "done"]);
    const slotDir = ctx?.slotDir;
    const newProjectName = ctx?.newProjectName;
    if (CONTAINER_STAGES.has(reachedStage()) && slotDir && newProjectName) {
      try {
        const cleanupComposeArgs = await slotComposeFiles(slotDir);
        await execFileAsync(
          "docker",
          ["compose", ...cleanupComposeArgs, "-p", newProjectName, "down", "--remove-orphans"],
          { cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT }
        );
        log(`[deploy] Cleaned up containers after failure`);
      } catch {
        // Best effort — containers may not have started
      }
    }

    fail();
    await db
      .update(deployments)
      .set({ status: "failed", log: logLines.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    await db
      .update(apps)
      .set(statusChange("error"))
      .where(eq(apps.id, opts.appId));

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

      // Security scan, backup, monitoring hooks are handled by plugins
      // via executeHooks("after.deploy.success") in post-deploy step.
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

// ---------------------------------------------------------------------------
// Exported helpers (used by deploy step files)
// ---------------------------------------------------------------------------

export async function checkEndpoint(domain: string, logs: { push: (line: string) => void }): Promise<boolean> {
  const paths = ["/healthz", "/health", "/"];
  const timeout = ENDPOINT_CHECK_TIMEOUT;

  for (const path of paths) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(`https://${domain}${path}`, {
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (res.ok) {
        logs.push(`[health] ${domain}${path} → ${res.status}`);
        return true;
      }
    } catch { /* next path */ }
  }

  // Fallback to HTTP
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`http://${domain}/`, {
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (res.ok) return true;
  } catch { /* not reachable */ }

  return false;
}


// ---------------------------------------------------------------------------
// Stop / Restart
// ---------------------------------------------------------------------------

/**
 * Resolve the active slot directory and compose project name.
 * Local environments use a single `local/` directory with no slot suffix.
 * Blue-green environments read the `current` symlink and fall back to `"blue"`.
 */
async function resolveActiveSlot(
  dir: string,
  projectPrefix: string,
): Promise<{ slotDir: string; composeProject: string }> {
  // Check for local environment first
  const { access: fsAccess } = await import("fs/promises");
  try {
    await fsAccess(join(dir, "local"));
    // No current symlink + local/ exists = local environment
    try {
      await readlink(join(dir, "current"));
    } catch {
      return {
        slotDir: join(dir, "local"),
        composeProject: projectPrefix,
      };
    }
  } catch {
    // No local/ directory — standard blue-green
  }

  // Same resolution as the deploy path: symlink → running slot → legacy file.
  // Falls back to "blue" only when nothing is detectable (stopping a project
  // that doesn't exist is a harmless no-op).
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
  /** App and environment names — omitted for the legacy unscoped layout. */
  shared?: { appName: string; envName: string },
): Promise<void> {
  const { slotDir, composeProject } = await resolveActiveSlot(dir, projectPrefix);
  const composeFileArgs = await slotComposeFiles(slotDir);

  const down = async (project: string) => {
    try {
      const args = ["compose", ...composeFileArgs, "-p", project, "down"];
      if (removeVolumes) {
        args.push("--volumes");
      }
      const { stdout, stderr } = await execFileAsync("docker", args, { cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT });
      if (stdout.trim()) logs.push(stdout.trim());
      if (stderr.trim()) logs.push(stderr.trim());
    } catch (err) {
      logs.push(`Warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await down(composeProject);

  // No deploy ever takes the shared project down. Left up, its containers
  // outlive the app and the reconciler reports the stopped app as active.
  if (shared && (await readSlotPartition(slotDir))) {
    await down(sharedProjectName(shared.appName, shared.envName));
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
    // Every path below reaches `docker compose down` through a name-derived
    // directory. Do not move or remove this.
    await assertAppDirOwnership({
      appId,
      appName,
      operation: removeVolumes ? "stop and remove volumes for" : "stop",
    });

    if (environmentName) {
      // Stop specific environment
      const envDir = appEnvDir(appName, environmentName);
      await stopSlotInDir(envDir, `${appName}-${environmentName}`, logs, removeVolumes, {
        appName,
        envName: environmentName,
      });
    } else {
      // Stop all environments — try env-aware layout first
      const baseDir = appBaseDir(appName);
      try {
        const { readdir } = await import("fs/promises");
        const entries = await readdir(baseDir, { withFileTypes: true });
        const envDirs = entries.filter((e) => e.isDirectory() && e.name !== "repo");
        if (envDirs.length > 0) {
          for (const entry of envDirs) {
            // Skip blue/green slot dirs at app root (legacy layout)
            if (entry.name === "blue" || entry.name === "green") {
              await stopSlotInDir(baseDir, appName, logs, removeVolumes);
              break;
            }
            const envDir = join(baseDir, entry.name);
            await stopSlotInDir(envDir, `${appName}-${entry.name}`, logs, removeVolumes, {
              appName,
              envName: entry.name,
            });
          }
        } else {
          // Legacy: slot dirs directly under app
          await stopSlotInDir(baseDir, appName, logs, removeVolumes);
        }
      } catch {
        // Fallback to legacy layout
        await stopSlotInDir(baseDir, appName, logs, removeVolumes);
      }
    }

    const stoppedAt = new Date();
    await db
      .update(apps)
      .set(statusChange("stopped", stoppedAt))
      .where(eq(apps.id, appId));

    // Cascade stop status to compose child services
    await db
      .update(apps)
      .set(statusChange("stopped", stoppedAt))
      .where(eq(apps.parentAppId, appId));

    return { success: true, log: logs.join("\n") };
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

    // Guard the slot directory up front. execFile with a non-existent `cwd`
    // fails with the misleading "spawn docker ENOENT" (which looks like a
    // missing docker binary). An absent slot dir means the app was never
    // deployed to disk — there is nothing to restart in place; the caller
    // should deploy instead.
    const { access: fsAccess } = await import("fs/promises");
    try {
      await fsAccess(slotDir);
    } catch {
      return {
        success: false,
        log: `No deployed compose project found for ${appName} (missing ${slotDir}). Deploy the app to bring it up.`,
      };
    }

    const composeFileArgs = await slotComposeFiles(slotDir);

    // A shared service has no container in the slot project, where `restart`
    // would silently match nothing.
    let targetProject = composeProject;
    if (service && environmentName) {
      const partition = await readSlotPartition(slotDir);
      if (partition && service in partition.shared) {
        targetProject = sharedProjectName(appName, environmentName);
      }
    }

    const restartArgs = ["compose", ...composeFileArgs, "-p", targetProject, "restart"];
    if (service) restartArgs.push(service);

    const { stdout, stderr } = await execFileAsync(
      "docker",
      restartArgs,
      { cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT }
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
    const composeFileArgs = await slotComposeFiles(slotDir);

    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", ...composeFileArgs, "-p", composeProject, "up", "-d", "--force-recreate"],
      { cwd: slotDir, timeout: COMPOSE_RESTART_TIMEOUT }
    );
    for (const line of stdout.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }
    for (const line of stderr.split(/\r?\n|\r/).filter(Boolean)) {
      logs.push(`[deploy][compose] ${line.trim()}`);
    }

    // Clear needsRedeploy flag since containers were recreated with fresh env
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

