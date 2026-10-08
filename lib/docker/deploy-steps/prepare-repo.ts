// Deploy step 1: auth, clone, host.toml and compose discovery, or a local image build.

import { db } from "@/lib/db";
import {
  volumes,
  githubAppInstallations,
  memberships,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readFile, rm } from "fs/promises";
import { join } from "path";
import { appBaseDir, appEnvDir, PROJECTS_DIR } from "@/lib/paths";
import {
  droppedKeyWarnings,
  generateComposeForImage,
  hostAccessErrors,
  parseCompose,
  parseComposeYaml,
  sanitizeCompose,
  sharedMarkerTypeErrors,
  sharedMarkerWarnings,
  unmarkedSharedVolumeWarnings,
  validateCompose,
  type ComposeFile,
} from "../compose";
import { isFeatureEnabled } from "@/lib/config/features";
import { assertSafeBranch, assertSafeGitUrl } from "../validate";
import { appRootDir } from "../compose-root";
import { DeployBlockedError } from "../errors";
import { assertBuildKitReachable, isBuildKitReachable, DEFAULT_BUILDKIT_HOST } from "../buildkit";
import { assertAppDirOwnership } from "../app-dir-owner";
import { getInstallationToken, getRepoInstallationId } from "@/lib/git-integration/app";
import { githubTokenGitEnv, resolveCloneToken } from "@/lib/git-integration/clone-auth";
import {
  getDecryptedPrivateKey,
  writeTemporaryKeyFile,
  cleanupKeyFile,
  buildGitSshCommand,
} from "@/lib/crypto/deploy-key";
import { detectPreventiveFixes, detectCompatIssues, applyCompatFixes } from "../compat";
import { checkoutRollbackSha } from "./checkout-sha";
import { withRegistryAuth } from "../registry-auth";
import {
  APP_UID,
  GIT_CLONE_TIMEOUT,
  GIT_METADATA_TIMEOUT,
  DOCKER_CLEANUP_TIMEOUT,
  ensureWritableDir,
} from "../constants";
import type { DeployContext } from "../deploy-context";
import { deployments } from "@/lib/db/schema";
import { execFileAsync } from "@/lib/utils/exec";
import { boundedBuild, buildKitLimit, explainBuildOom } from "../build-memory";

type ParseAndSanitizeOpts = {
  allowBindMounts?: boolean;
  allowDockerSocket?: boolean;
  orgTrusted?: boolean;
};

export function parseAndSanitize(yaml: string, log: (msg: string) => void, opts?: ParseAndSanitizeOpts): ComposeFile {
  // Check markers before parseCompose drops non-boolean ones; git compose skips the save-route checks.
  for (const warning of sharedMarkerWarnings(yaml)) {
    log(`[deploy] Warning: ${warning}`);
  }
  const markerErrors = sharedMarkerTypeErrors(yaml);
  if (markerErrors.length > 0) {
    throw new DeployBlockedError(
      `${markerErrors.join("\n")}\n` +
        `If this is a rollback, the commit cannot be edited — use instant rollback, ` +
        `which restores the previous slot's containers without rebuilding.`,
    );
  }
  for (const warning of droppedKeyWarnings(parseComposeYaml(yaml))) {
    log(`[deploy] Warning: ${warning}`);
  }
  const compose = parseCompose(yaml);
  for (const warning of unmarkedSharedVolumeWarnings(compose)) {
    log(`[deploy] Warning: ${warning}`);
  }
  // Trusted orgs bypass all mount restrictions.
  if (opts?.orgTrusted) {
    const { valid, errors } = validateCompose(compose, { allowBindMounts: true, skipMountChecks: true });
    if (!valid) {
      throw new DeployBlockedError(`Compose validation failed:\n${errors.join("\n")}`);
    }
    return compose;
  }
  const hostErrors = hostAccessErrors(compose);
  if (hostErrors.length > 0) {
    throw new DeployBlockedError(hostErrors.join("\n"));
  }
  const bindMountsEnabled = opts?.allowBindMounts || isFeatureEnabled("bindMounts");
  const dockerSocketEnabled = opts?.allowDockerSocket || isFeatureEnabled("dockerSocket");
  const mountOpts = { allowBindMounts: bindMountsEnabled, allowDockerSocket: dockerSocketEnabled };
  let sanitized: ReturnType<typeof sanitizeCompose>;
  try {
    sanitized = sanitizeCompose(compose, mountOpts);
  } catch (err) {
    throw new DeployBlockedError(err instanceof Error ? err.message : String(err));
  }
  if (sanitized.strippedMounts.length > 0) {
    log(`[deploy] Stripped ${sanitized.strippedMounts.length} bind mount(s): ${sanitized.strippedMounts.join(", ")}`);
  }
  const { valid, errors } = validateCompose(sanitized.compose, mountOpts);
  if (!valid) {
    throw new DeployBlockedError(`Compose validation failed:\n${errors.join("\n")}`);
  }
  return sanitized.compose;
}

/** Persist new named volumes from a parsed compose file. */
async function detectAndPersistComposeVolumes(
  compose: ComposeFile,
  appId: string,
  organizationId: string,
  existingVolumeNames: Set<string>,
  log: (msg: string) => void,
): Promise<void> {
  if (!compose.volumes || Object.keys(compose.volumes).length === 0) return;

  const seen = new Set(existingVolumeNames);
  const newVols: { name: string; mountPath: string }[] = [];

  for (const svc of Object.values(compose.services)) {
    for (const vol of svc.volumes ?? []) {
      const parts = vol.split(":");
      if (parts.length >= 2) {
        const volName = parts[0];
        const mountPath = parts[1];
        if (volName in compose.volumes! && !seen.has(volName)) {
          seen.add(volName);
          newVols.push({ name: volName, mountPath });
        }
      }
    }
  }

  if (newVols.length > 0) {
    for (const vol of newVols) {
      await db.insert(volumes).values({
        id: nanoid(),
        appId,
        organizationId,
        name: vol.name,
        mountPath: vol.mountPath,
        persistent: true,
      }).onConflictDoNothing();
    }
    log(`[deploy] Detected ${newVols.length} compose volume(s): ${newVols.map(v => `${v.name}:${v.mountPath}`).join(", ")}`);
  }
}

import { spawn as nodeSpawn } from "child_process";
import { BUILD_TIMEOUT } from "../constants";
import { dockerEnv } from "@/lib/docker/docker-env";

function spawnStream(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  logs: { push: (line: string) => void },
  prefix: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stderrBuf = "";
    let killed = false;

    function killProcessGroup() {
      if (killed || proc.pid === undefined) return;
      killed = true;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        killProcessGroup();
      } else {
        opts.signal.addEventListener("abort", killProcessGroup, { once: true });
      }
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logs.push(`${prefix} ${line}`);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logs.push(`${prefix} ${line}`);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else if (killed && opts.signal?.aborted) {
        reject(new Error("Deployment aborted"));
      } else {
        reject(new Error(`${cmd} failed (exit ${code}): ${stderrBuf.slice(-500)}`));
      }
    });

    proc.on("error", (err) => reject(err));

    const timeout = setTimeout(() => {
      killProcessGroup();
      reject(new Error(`${cmd} timed out after ${BUILD_TIMEOUT / 1000}s`));
    }, BUILD_TIMEOUT);

    proc.on("close", () => clearTimeout(timeout));
  });
}

async function buildFromRepo(
  repoPath: string,
  imageName: string,
  deployType: string,
  logs: { push: (line: string) => void },
  envVars?: Record<string, string>,
  dockerfilePath?: string,
  signal?: AbortSignal,
): Promise<void> {
  // Base images may be private, so builders get registry credentials.
  await withRegistryAuth(async (authEnv) => {
    // App vars reach the builders only through --env; in the process env, LD_PRELOAD or PATH would run repo code here.
    const buildEnv = { ...authEnv };

    if (deployType === "nixpacks") {
      logs.push(`[build] Building with Nixpacks...`);
      const args = ["build", repoPath, "--name", imageName];
      if (envVars) {
        for (const [k, v] of Object.entries(envVars)) {
          args.push("--env", `${k}=${v}`);
        }
      }
      await spawnStream("nixpacks", args, { cwd: repoPath, env: buildEnv, signal }, logs, "[build][nixpacks]");
      logs.push(`[build] Nixpacks build complete: ${imageName}`);
      return;
    }

    if (deployType === "railpack") {
      // Railpack needs BuildKit; fail fast when it isn't reachable.
      if (!buildEnv.BUILDKIT_HOST) buildEnv.BUILDKIT_HOST = DEFAULT_BUILDKIT_HOST;
      await assertBuildKitReachable(buildEnv.BUILDKIT_HOST, signal);

      logs.push(`[build] Building with Railpack...`);
      const args = ["build", "--name", imageName];
      if (envVars) {
        for (const [k, v] of Object.entries(envVars)) {
          args.push("--env", `${k}=${v}`);
        }
      }
      args.push(repoPath);
      try {
        await spawnStream("railpack", args, { cwd: repoPath, env: buildEnv, signal }, logs, "[build][railpack]");
      } catch (err) {
        throw explainBuildOom(err, await buildKitLimit(buildEnv.BUILDKIT_HOST));
      }
      logs.push(`[build] Railpack build complete: ${imageName}`);
      return;
    }

    const dfPath = dockerfilePath || "Dockerfile";
    logs.push(`[build] Building with Dockerfile (${dfPath})...`);
    const bounded = await boundedBuild((line) => logs.push(line), signal);
    const args = ["build", ...bounded.loadArgs, "-t", imageName, "-f", join(repoPath, dfPath)];
    if (envVars) {
      for (const [k, v] of Object.entries(envVars)) {
        args.push("--build-arg", `${k}=${v}`);
      }
    }
    args.push(repoPath);
    try {
      await spawnStream("docker", args, { cwd: repoPath, env: { ...authEnv, ...bounded.env }, signal }, logs, "[build][docker]");
    } catch (err) {
      throw explainBuildOom(err, bounded);
    }
    logs.push(`[build] Docker build complete: ${imageName}`);
  });
}

export async function prepareRepo(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, envMap, signal } = ctx;
  const orgTrusted = ctx.orgTrusted;
  const projectAllowBindMounts = ctx.projectAllowBindMounts;
  const projectAllowDockerSocket = ctx.projectAllowDockerSocket;

  // Refuse before recursively deleting a directory another app owns.
  await assertAppDirOwnership({ appId: ctx.appId, appName: app.name, operation: "deploy" });

  // App-level dir holds the repo; env-level dir holds slots.
  const appBase = appBaseDir(app.name);
  const appDir = appEnvDir(app.name, ctx.envName);
  await ensureWritableDir(appDir);

  ctx.appBase = appBase;
  ctx.appDir = appDir;

  const appVolumes = await db.query.volumes.findMany({
    where: eq(volumes.appId, ctx.appId),
  });
  const volumesList = appVolumes.filter((v) => v.persistent).map((v) => ({ name: v.name, mountPath: v.mountPath }));
  ctx.appVolumes = appVolumes;
  ctx.volumesList = volumesList;

  // Direct compose with `build:` directives switches to git source.
  let effectiveSource = app.source;
  if (app.source === "direct" && app.composeContent && app.deployType === "compose") {
    try {
      const preCheck = parseCompose(app.composeContent);
      const hasBuildDirective = Object.values(preCheck.services).some((svc) => svc.build);
      if (hasBuildDirective) {
        if (app.gitUrl) {
          log(`[deploy] Compose has build: directives — upgrading to git source`);
          effectiveSource = "git";
        } else {
          throw new Error(
            "Compose has build: directives but no git repo configured. " +
            "Either set a git URL to provide build context, or use pre-built images."
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("build: directives")) {
        throw err;
      }
    }
  }
  ctx.effectiveSource = effectiveSource;

  let compose: ComposeFile;

  if (app.deployType === "image" && app.imageName) {
    ctx.stage("clone", "skipped");
    ctx.stage("compose", "running");
    if (app.composeContent) {
      compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted });
      log(`[deploy] Using stored compose for imported container: ${app.imageName}`);
    } else {
      const volsForCompose = volumesList.length > 0 ? volumesList : undefined;
      const exposedPorts = (app.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null) ?? undefined;
      compose = generateComposeForImage({
        projectName: app.name,
        imageName: app.imageName,
        containerPort: app.containerPort ?? undefined,
        envVars: envMap,
        volumes: volsForCompose,
        exposedPorts,
      });
      if (volsForCompose?.length) log(`[deploy] ${volsForCompose.length} persistent volume(s)`);
      if (exposedPorts?.length) log(`[deploy] ${exposedPorts.length} exposed port(s)`);
      log(`[deploy] Generated compose for image: ${app.imageName}`);
    }
  } else if (effectiveSource === "git" && app.gitUrl) {
    const repoDir = join(appBase, "repo");
    ctx.repoDir = repoDir;
    const branch = ctx.envBranchOverride || app.gitBranch || "main";
    try {
      assertSafeBranch(branch);
      assertSafeGitUrl(app.gitUrl);
    } catch (err) {
      throw new DeployBlockedError(err instanceof Error ? err.message : String(err));
    }

    // Authenticated clone URL for private repos.
    let cloneUrl = app.gitUrl;
    const gitEnv: Record<string, string> = {};
    let sshKeyFile: string | null = null;
    let tokenAuth = false;

    // GitHub App token for github.com URLs.
    if (cloneUrl.startsWith("https://github.com/")) {
      try {
        const orgMembers = await db.query.memberships.findMany({
          where: eq(memberships.organizationId, ctx.organizationId),
          columns: { userId: true },
        });
        const userIds = orgMembers.map((m) => m.userId);

        const installations = [];
        for (const userId of userIds) {
          installations.push(
            ...(await db.query.githubAppInstallations.findMany({
              where: eq(githubAppInstallations.userId, userId),
            })),
          );
        }
        const installToken = await resolveCloneToken(app.gitUrl, installations, {
          getToken: getInstallationToken,
          getRepoInstallationId,
          log,
        });

        if (installToken) {
          // An env header, so the token never lands in .git/config inside the build context.
          Object.assign(gitEnv, githubTokenGitEnv(installToken));
          tokenAuth = true;
        }
      } catch (err) {
        log(`[deploy] Warning: GitHub auth — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Otherwise an SSH deploy key.
    if (!tokenAuth && app.gitKeyId) {
      try {
        const privateKeyPem = await getDecryptedPrivateKey(app.gitKeyId, app.organizationId);
        if (privateKeyPem) {
          sshKeyFile = await writeTemporaryKeyFile(privateKeyPem);
          gitEnv.GIT_SSH_COMMAND = buildGitSshCommand(sshKeyFile);

          if (cloneUrl.startsWith("https://")) {
            const url = new URL(cloneUrl);
            cloneUrl = `git@${url.hostname}:${url.pathname.replace(/^\//, "")}`;
            if (!cloneUrl.endsWith(".git")) cloneUrl += ".git";
          }

          log(`[deploy] Using SSH deploy key for authentication`);
        }
      } catch (err) {
        log(`[deploy] Warning: deploy key — ${err instanceof Error ? err.message : err}`);
      }
    }

    try {
      const execOpts = { timeout: GIT_CLONE_TIMEOUT, env: { ...process.env, ...gitEnv } };
      try {
        await execFileAsync("git", ["-C", repoDir, "remote", "set-url", "--", "origin", cloneUrl], execOpts);
        await execFileAsync("git", ["-C", repoDir, "fetch", "--", "origin", branch], execOpts);
        await execFileAsync("git", ["-C", repoDir, "reset", "--hard", `origin/${branch}`, "--"], execOpts);
        log(`[deploy] Pulled latest from ${branch}`);
      } catch {
        try {
          await rm(repoDir, { recursive: true, force: true });
        } catch (rmErr: unknown) {
          if (rmErr && typeof rmErr === "object" && "code" in rmErr && rmErr.code === "EACCES") {
            if (!repoDir.startsWith(PROJECTS_DIR + "/")) {
              throw new Error(`Refusing to docker-rm path outside apps dir: ${repoDir}`);
            }
            log(`[deploy] Permission denied removing ${repoDir}, retrying as root via docker`);
            await execFileAsync("docker", [
              "run", "--rm", "-v", `${repoDir}:/target`, "alpine",
              "sh", "-c", `rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; chown ${APP_UID}:${APP_UID} /target`,
            ], { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT });
          } else {
            throw rmErr;
          }
        }
        await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, "--", cloneUrl, repoDir], execOpts);
        log(`[deploy] Cloned repo (${branch})`);
      }

      // Rollback deploys ship the target commit, not the branch tip.
      if (ctx.rollback) {
        if (!ctx.rollback.gitSha) {
          throw new DeployBlockedError(
            `Rollback target ${ctx.rollback.targetDeploymentId} has no recorded git SHA — cannot roll back to it`,
          );
        }
        await checkoutRollbackSha(
          (args) => execFileAsync("git", ["-C", repoDir, ...args], execOpts),
          ctx.rollback.gitSha,
          log,
        );
      }
    } finally {
      if (sshKeyFile) {
        await cleanupKeyFile(sshKeyFile);
      }
    }

    try {
      const { stdout: sha } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], { timeout: GIT_METADATA_TIMEOUT });
      const { stdout: msg } = await execFileAsync("git", ["-C", repoDir, "log", "-1", "--format=%s"], { timeout: GIT_METADATA_TIMEOUT });
      const gitSha = sha.trim();
      const gitMessage = msg.trim();
      log(`[deploy] Commit: ${gitSha.slice(0, 7)} ${gitMessage}`);
      await db
        .update(deployments)
        .set({ gitSha, gitMessage })
        .where(eq(deployments.id, ctx.deploymentId));
    } catch { /* not critical */ }

    const { readHostConfig, applyHostConfig } = await import("@/lib/config/host-config");
    const hostConfig = await readHostConfig(repoDir);
    ctx.hostConfig = hostConfig;
    if (hostConfig) {
      const applied = applyHostConfig(hostConfig);
      log(`[deploy] Found host.toml`);
      if (applied.containerPort) {
        envMap.PORT = String(applied.containerPort);
        log(`[deploy] host.toml: port ${applied.containerPort}`);
      }
      if (applied.envVars) {
        for (const { key, value } of applied.envVars) {
          if (!(key in envMap)) {
            envMap[key] = value;
          }
        }
        log(`[deploy] host.toml: ${applied.envVars.length} env var(s)`);
      }
      if (applied.persistentVolumes) {
        for (const vol of applied.persistentVolumes) {
          await db.insert(volumes).values({
            id: nanoid(),
            appId: ctx.appId,
            organizationId: ctx.organizationId,
            name: vol.name,
            mountPath: vol.mountPath,
            persistent: true,
          }).onConflictDoNothing();
        }
        const refreshed = await db.query.volumes.findMany({
          where: eq(volumes.appId, ctx.appId),
        });
        volumesList.length = 0;
        volumesList.push(...refreshed.filter((v) => v.persistent).map((v) => ({ name: v.name, mountPath: v.mountPath })));
        log(`[deploy] host.toml: ${applied.persistentVolumes.length} volume(s)`);
      }
    }

    const root = appRootDir(repoDir, app.rootDirectory || hostConfig?.project?.rootDirectory);
    const composeFilePath = app.composeFilePath || "docker-compose.yml";
    const composeCandidates = [
      composeFilePath,
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ];

    let composeContent: string | null = null;
    if (app.deployType === "compose") {
      for (const candidate of composeCandidates) {
        try {
          composeContent = await readFile(join(root, candidate), "utf-8");
          log(`[deploy] Found ${candidate}`);
          break;
        } catch { /* try next */ }
      }
    }

    ctx.stage("clone", "success");
    ctx.stage("compose", "running");

    if (composeContent && app.deployType === "compose") {
      compose = parseAndSanitize(composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted });
      await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
    } else {
      // Build from repo: Dockerfile, Railpack or Nixpacks.
      const imageName = `host/${app.name}:${ctx.deploymentId.slice(0, 8)}`;
      let buildType = app.deployType;

      if (buildType === "compose" && !composeContent) {
        const dockerfileToCheck = app.dockerfilePath || "Dockerfile";
        try {
          await readFile(join(root, dockerfileToCheck), "utf-8");
          buildType = "dockerfile";
          log(`[deploy] No compose file, found ${dockerfileToCheck}`);
        } catch {
          // Prefer Railpack when the opt-in BuildKit daemon is reachable.
          const buildKitHost = process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST;
          if (await isBuildKitReachable(buildKitHost, ctx.signal)) {
            buildType = "railpack";
            log(`[deploy] No compose file or Dockerfile — building with Railpack (BuildKit available)`);
          } else {
            buildType = "nixpacks";
            log(`[deploy] No compose file or Dockerfile — building with Nixpacks (BuildKit not reachable)`);
          }
        }
      }

      const preventiveFixes = await detectPreventiveFixes(root);
      if (preventiveFixes.length > 0) {
        for (const fix of preventiveFixes) {
          log(`[compat] ${fix.name}: ${fix.description}`);
        }
        Object.assign(envMap, applyCompatFixes(envMap, preventiveFixes));
      }

      ctx.stage("compose", "success");
      ctx.stage("build", "running");

      const customDockerfile = app.dockerfilePath && app.dockerfilePath !== "Dockerfile" ? app.dockerfilePath : undefined;
      try {
        await buildFromRepo(root, imageName, buildType, logs, envMap, customDockerfile, signal);
      } catch (buildErr) {
        const errMsg = buildErr instanceof Error ? buildErr.message : String(buildErr);

        if (signal?.aborted) throw buildErr;

        const fixes = detectCompatIssues(errMsg);
        if (fixes.length > 0) {
          log(`[compat] Build failed, detected fixable issues:`);
          for (const fix of fixes) {
            log(`[compat]   ${fix.name}: ${fix.description}`);
          }
          log(`[compat] Retrying with fixes applied...`);
          Object.assign(envMap, applyCompatFixes(envMap, fixes));
          await buildFromRepo(root, imageName, buildType, logs, envMap, customDockerfile, signal);
        } else {
          throw buildErr;
        }
      }

      ctx.builtLocally = true;
      // Local-only image; the swap pre-pull must skip it.
      ctx.builtImageRefs.push(imageName);
      compose = generateComposeForImage({
        projectName: app.name,
        imageName,
        containerPort: app.containerPort ?? undefined,
        envVars: envMap,
        volumes: volumesList.length > 0 ? volumesList : undefined,
        exposedPorts: (app.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null) ?? undefined,
      });
    }
  } else if (app.composeContent) {
    ctx.stage("clone", "skipped");
    ctx.stage("compose", "running");
    compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted });
    log(`[deploy] Parsed compose content`);
    await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
  } else {
    throw new Error("No image, git repo, or compose content configured");
  }

  ctx.compose = compose;
  return ctx;
}

