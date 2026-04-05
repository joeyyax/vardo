// ---------------------------------------------------------------------------
// Deploy Step 1: Prepare repository and generate/fetch compose file
//
// Handles: git auth (GitHub App token, SSH deploy key), clone/pull,
// host.toml parsing, compose file discovery, image-based compose generation,
// direct compose content, and Nixpacks/Railpack/Dockerfile builds.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  apps,
  volumes,
  projects,
  organizations,
  environments,
  githubAppInstallations,
  memberships,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { appBaseDir, appEnvDir, PROJECTS_DIR } from "@/lib/paths";
import { decrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import {
  generateComposeForImage,
  parseCompose,
  sanitizeCompose,
  validateCompose,
  type ComposeFile,
} from "../compose";
import { isFeatureEnabled } from "@/lib/config/features";
import { assertSafeBranch } from "../validate";
import { DeployBlockedError } from "../errors";
import { getInstallationToken } from "@/lib/git-integration/app";
import {
  getDecryptedPrivateKey,
  writeTemporaryKeyFile,
  cleanupKeyFile,
  buildGitSshCommand,
} from "@/lib/crypto/deploy-key";
import { detectPreventiveFixes, detectCompatIssues, applyCompatFixes } from "../compat";
import {
  APP_UID,
  GIT_CLONE_TIMEOUT,
  GIT_METADATA_TIMEOUT,
  DOCKER_CLEANUP_TIMEOUT,
  ensureWritableDir,
} from "../constants";
import type { DeployContext } from "../deploy-context";
import { deployments } from "@/lib/db/schema";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParseAndSanitizeOpts = {
  allowBindMounts?: boolean;
  orgTrusted?: boolean;
};

function parseAndSanitize(yaml: string, log: (msg: string) => void, opts?: ParseAndSanitizeOpts): ComposeFile {
  const compose = parseCompose(yaml);
  // Trusted orgs bypass all mount restrictions — no sanitization, no deny list.
  if (opts?.orgTrusted) {
    const { valid, errors } = validateCompose(compose, { allowBindMounts: true, skipMountChecks: true });
    if (!valid) {
      throw new DeployBlockedError(`Compose validation failed:\n${errors.join("\n")}`);
    }
    return compose;
  }
  const bindMountsEnabled = opts?.allowBindMounts || isFeatureEnabled("bindMounts");
  let sanitized: ReturnType<typeof sanitizeCompose>;
  try {
    sanitized = sanitizeCompose(compose, { allowBindMounts: bindMountsEnabled });
  } catch (err) {
    throw new DeployBlockedError(err instanceof Error ? err.message : String(err));
  }
  if (sanitized.strippedMounts.length > 0) {
    log(`[deploy] Stripped ${sanitized.strippedMounts.length} bind mount(s): ${sanitized.strippedMounts.join(", ")}`);
  }
  const { valid, errors } = validateCompose(sanitized.compose, { allowBindMounts: bindMountsEnabled });
  if (!valid) {
    throw new DeployBlockedError(`Compose validation failed:\n${errors.join("\n")}`);
  }
  return sanitized.compose;
}

/**
 * Detect named volumes from a parsed compose file and persist any new ones to the DB.
 * Shared by git-sourced and direct compose deploy paths.
 */
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

// ---------------------------------------------------------------------------
// buildFromRepo — local image builds (Nixpacks, Railpack, Dockerfile)
// ---------------------------------------------------------------------------

import { spawn as nodeSpawn } from "child_process";
import { BUILD_TIMEOUT } from "../constants";

function spawnStream(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  logs: { push: (line: string) => void },
  prefix: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
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
        // Process may have already exited — ignore
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
  const buildEnv = { ...process.env, ...envVars };

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
    logs.push(`[build] Building with Railpack...`);
    const args = ["build", "--name", imageName];
    if (envVars) {
      for (const [k, v] of Object.entries(envVars)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    args.push(repoPath);
    await spawnStream("railpack", args, { cwd: repoPath, env: buildEnv, signal }, logs, "[build][railpack]");
    logs.push(`[build] Railpack build complete: ${imageName}`);
    return;
  }

  const dfPath = dockerfilePath || "Dockerfile";
  logs.push(`[build] Building with Dockerfile (${dfPath})...`);
  const args = ["build", "-t", imageName, "-f", join(repoPath, dfPath)];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      args.push("--build-arg", `${k}=${v}`);
    }
  }
  args.push(repoPath);
  await spawnStream("docker", args, { cwd: repoPath, signal }, logs, "[build][docker]");
  logs.push(`[build] Docker build complete: ${imageName}`);
}

// ---------------------------------------------------------------------------
// Step entry point
// ---------------------------------------------------------------------------

export async function prepareRepo(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, envMap, signal } = ctx;
  const orgTrusted = ctx.orgTrusted;
  const projectAllowBindMounts = ctx.projectAllowBindMounts;

  // App-level dir holds the repo; env-level dir holds slots
  const appBase = appBaseDir(app.name);
  const appDir = appEnvDir(app.name, ctx.envName);
  await ensureWritableDir(appDir);

  ctx.appBase = appBase;
  ctx.appDir = appDir;

  // Load volumes from the volumes table
  const appVolumes = await db.query.volumes.findMany({
    where: eq(volumes.appId, ctx.appId),
  });
  const volumesList = appVolumes.filter((v) => v.persistent).map((v) => ({ name: v.name, mountPath: v.mountPath }));
  ctx.appVolumes = appVolumes;
  ctx.volumesList = volumesList;

  // Auto-upgrade to git source when compose has build: directives but source is direct
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
    // Image deploy — no clone needed
    ctx.stage("clone", "skipped");
    ctx.stage("build", "running");
    if (app.composeContent) {
      compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, orgTrusted });
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
    // Git source — clone/pull repo with GitHub App auth if needed
    const repoDir = join(appBase, "repo");
    ctx.repoDir = repoDir;
    const branch = ctx.envBranchOverride || app.gitBranch || "main";
    assertSafeBranch(branch);

    // Build authenticated clone URL/env for private repos
    let cloneUrl = app.gitUrl;
    const gitEnv: Record<string, string> = {};
    let sshKeyFile: string | null = null;

    // Strategy 1: GitHub App token (for github.com URLs)
    if (cloneUrl.includes("github.com")) {
      try {
        const orgMembers = await db.query.memberships.findMany({
          where: eq(memberships.organizationId, ctx.organizationId),
          columns: { userId: true },
        });
        const userIds = orgMembers.map((m) => m.userId);

        let installToken: string | null = null;
        for (const userId of userIds) {
          const installations = await db.query.githubAppInstallations.findMany({
            where: eq(githubAppInstallations.userId, userId),
          });
          for (const inst of installations) {
            try {
              installToken = await getInstallationToken(inst.installationId);
              log(`[deploy] Got GitHub token via ${inst.accountLogin}`);
              break;
            } catch { /* try next */ }
          }
          if (installToken) break;
        }

        if (installToken) {
          cloneUrl = cloneUrl.replace(
            "https://github.com/",
            `https://x-access-token:${installToken}@github.com/`
          );
        }
      } catch (err) {
        log(`[deploy] Warning: GitHub auth — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Strategy 2: SSH deploy key
    if (cloneUrl === app.gitUrl && app.gitKeyId) {
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
        await execFileAsync("git", ["-C", repoDir, "remote", "set-url", "origin", cloneUrl], execOpts);
        await execFileAsync("git", ["-C", repoDir, "fetch", "origin", branch], execOpts);
        await execFileAsync("git", ["-C", repoDir, "reset", "--hard", `origin/${branch}`], execOpts);
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
            ], { timeout: DOCKER_CLEANUP_TIMEOUT });
          } else {
            throw rmErr;
          }
        }
        await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, repoDir], execOpts);
        log(`[deploy] Cloned repo (${branch})`);
      }
    } finally {
      if (sshKeyFile) {
        await cleanupKeyFile(sshKeyFile);
      }
    }

    // Capture git SHA + commit message
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

    // Read host.toml config if present
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

    // Find compose file
    const root = app.rootDirectory
      ? join(repoDir, app.rootDirectory)
      : hostConfig?.project?.rootDirectory
      ? join(repoDir, hostConfig.project.rootDirectory)
      : repoDir;
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
    ctx.stage("build", "running");

    if (composeContent && app.deployType === "compose") {
      compose = parseAndSanitize(composeContent, log, { allowBindMounts: projectAllowBindMounts, orgTrusted });
      await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
    } else {
      // Build from repo — Nixpacks, Dockerfile, or auto-detect
      const imageName = `host/${app.name}:${ctx.deploymentId.slice(0, 8)}`;
      let buildType = app.deployType;

      if (buildType === "compose" && !composeContent) {
        const dockerfileToCheck = app.dockerfilePath || "Dockerfile";
        try {
          await readFile(join(root, dockerfileToCheck), "utf-8");
          buildType = "dockerfile";
          log(`[deploy] No compose file, found ${dockerfileToCheck}`);
        } catch {
          buildType = "nixpacks";
          log(`[deploy] No compose file or Dockerfile, falling back to Nixpacks`);
        }
      }

      // Apply preventive compatibility fixes
      const preventiveFixes = await detectPreventiveFixes(root);
      if (preventiveFixes.length > 0) {
        for (const fix of preventiveFixes) {
          log(`[compat] ${fix.name}: ${fix.description}`);
        }
        Object.assign(envMap, applyCompatFixes(envMap, preventiveFixes));
      }

      // First build attempt
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
    // Direct compose content
    compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, orgTrusted });
    log(`[deploy] Parsed compose content`);
    await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
  } else {
    throw new Error("No image, git repo, or compose content configured");
  }

  ctx.compose = compose;
  return ctx;
}
