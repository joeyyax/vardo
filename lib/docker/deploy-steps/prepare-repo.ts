// Deploy step 1: auth, clone, host.toml and compose discovery, or a local image build.

import { deploymentImageName } from "@/lib/docker/image-tag";
import { db } from "@/lib/db";
import { volumes } from "@/lib/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readFile, rm } from "fs/promises";
import { join } from "path";
import { appBaseDir, appEnvDir, PROJECTS_DIR } from "@/lib/paths";
import {
  droppedKeyWarnings,
  generateComposeForImage,
  hostAccessErrors,
  hostAccessSettings,
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
import { assertGitHostAllowed, GIT_NO_REDIRECT } from "../git-host";
import { appRootDir, repoFilePath } from "../compose-root";
import { DeployBlockedError } from "../errors";
import { assertBuildKitReachable, isBuildKitReachable, DEFAULT_BUILDKIT_HOST } from "../buildkit";
import { assertAppDirOwnership } from "../app-dir-owner";
import { getInstallationToken, getRepoInstallationId } from "@/lib/git-integration/app";
import { credentialGitEnv, githubTokenGitEnv, parseGithubRepo, resolveCloneToken } from "@/lib/git-integration/clone-auth";
import { splitGitUrl } from "@/lib/api/git-fields";
import { openGitCredentials } from "@/lib/api/git-credentials";
import { LINK_INSTALLATION_HINT, orgInstallations } from "@/lib/git-integration/org-installations";
import {
  getDecryptedPrivateKey,
  writeTemporaryKeyFile,
  cleanupKeyFile,
  buildGitSshCommand,
} from "@/lib/crypto/deploy-key";
import { detectPreventiveFixes, detectCompatIssues, applyCompatFixes } from "../compat";
import { checkoutCommit } from "./checkout-sha";
import { buildRegistryOps, withRegistryAuth } from "../registry-auth";
import type { RegistryOps } from "../build-registry";
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
import { dockerfileBuildArgs, nixpacksBuildArgs, railpackBuildArgs, type BuildOverrides } from "../buildpack-args";
import { ENGINE_NAME, buildPlanLogLines, captureBuildPlan, describeMarkers, providerMarkers, type BuildPlanRecord, type ProviderMarker } from "../build-plan";
import { buildKey, findReusableImage } from "../build-key";
import { engineVersion } from "../engine-version";
import { boundedBuild, buildKitLimit, explainBuildOom, type BoundedBuild } from "../build-memory";
import { withBuildSlot, type BuildGate } from "../build-gate";
import { configuredTargets, onTarget, remoteEnv, type BuildTarget } from "../build-targets";
import { bringBack } from "../remote-build";
import { withTargetBuilder } from "../target-builder";
import { bringDirect, pushedName } from "../direct-export";
import { generateNixpacksDockerfile, removeNixpacksDir } from "../nixpacks-dockerfile";
import { applyComposeProfiles, parseComposeProfiles } from "../compose-profiles";
import { globalEnvValue, isSelfApp } from "../self-env";
import { contextBytesFromBuildOutput, exportMsFromBuildOutput } from "../stage-timings";
import { imagesBytes } from "../image-size";
import { acquireCheckoutLock, type CheckoutLock } from "../checkout-lock";
import {
  INCLUDE_GIT_ENV,
  branchFetchArgs,
  composeCandidates,
  copyGitDir,
  dockerfileNeedsGit,
  dockerfilesIn,
  syncBuildSource,
} from "../build-source";
import type { HostConfig } from "@/lib/config/host-config";

/** Writes the env's build tree at `sha`, with .git only when a Dockerfile reads it or the app asks. */
async function writeBuildSource(
  ctx: DeployContext,
  repoDir: string,
  sha: string,
  hostConfig: HostConfig | null,
): Promise<string> {
  const git = (args: string[], env?: Record<string, string>) =>
    execFileAsync("git", ["-C", repoDir, ...args], { timeout: GIT_CLONE_TIMEOUT, env: { ...process.env, ...env } });
  const dir = await syncBuildSource({ git, appDir: ctx.appDir, sha });
  const root = appRootDir(dir, ctx.app.rootDirectory || hostConfig?.project?.rootDirectory);
  const asked = ctx.envMap[INCLUDE_GIT_ENV] === "true";
  const reads = !asked && ctx.app.deployType !== "nixpacks" && ctx.app.deployType !== "railpack"
    ? (await dockerfilesIn(root, {
        dockerfilePath: ctx.app.dockerfilePath,
        composeFilePath: ctx.app.composeFilePath,
        compose: ctx.app.deployType === "compose",
      })).some(dockerfileNeedsGit)
    : false;
  ctx.buildSourceHasGit = asked || reads;
  if (ctx.buildSourceHasGit) {
    await copyGitDir({ git, repoDir, dir, sha });
    ctx.log(`[build] ${asked ? `${INCLUDE_GIT_ENV} is set` : "A Dockerfile reads .git"}, so the build context includes .git; every commit rebuilds from the first COPY of it`);
  }
  return dir;
}

type ParseAndSanitizeOpts = {
  allowBindMounts?: boolean;
  allowDockerSocket?: boolean;
  orgTrusted?: boolean;
  /** The system org's core services keep `pid`, which every other deploy drops. */
  systemManaged?: boolean;
};

function keepPid(compose: ComposeFile, raw: unknown): void {
  const services = (raw as { services?: Record<string, { pid?: unknown } | null> }).services ?? {};
  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc?.pid === "string" && svc.pid && compose.services[name]) compose.services[name].pid = svc.pid;
  }
}

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
  const raw = parseComposeYaml(yaml);
  const kept = opts?.systemManaged ? ["pid"] : [];
  for (const warning of droppedKeyWarnings(raw, kept)) {
    log(`[deploy] Warning: ${warning}`);
  }
  const compose = parseCompose(yaml);
  if (opts?.systemManaged) keepPid(compose, raw);
  for (const warning of unmarkedSharedVolumeWarnings(compose)) {
    log(`[deploy] Warning: ${warning}`);
  }
  // Trusted orgs bypass all mount restrictions.
  if (opts?.orgTrusted) {
    for (const { service, used } of hostAccessSettings(compose)) {
      log(`[deploy] Service "${service}" runs with ${used.join(", ")}, allowed for this trusted organization`);
    }
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

/** Tail of a build's output kept for timing; the export steps come last. */
const CAPTURE_MAX = 2 * 1024 * 1024;

/** How long a cancelled build client gets to cancel before its process group is killed. */
const KILL_GRACE_MS = 15_000;

function spawnStream(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  logs: { push: (line: string) => void },
  prefix: string,
  capture?: { text: string },
): Promise<void> {
  const keep = (chunk: Buffer) => {
    if (!capture) return;
    capture.text += chunk.toString();
    if (capture.text.length > CAPTURE_MAX) capture.text = capture.text.slice(-CAPTURE_MAX);
  };
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stderrBuf = "";
    let killed = false;
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | null = null;

    // The CLI alone first, so buildx cancels the build in BuildKit; the group after a grace period.
    function killProcessGroup() {
      if (killed || proc.pid === undefined) return;
      killed = true;
      const pid = proc.pid;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
      forceKill = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }, KILL_GRACE_MS);
      forceKill.unref?.();
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        killProcessGroup();
      } else {
        opts.signal.addEventListener("abort", killProcessGroup, { once: true });
      }
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      keep(chunk);
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logs.push(`${prefix} ${line}`);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      keep(chunk);
      stderrBuf += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logs.push(`${prefix} ${line}`);
      }
    });

    proc.on("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      // Settles once the client has exited, so the builder slot frees after the build is cancelled.
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${BUILD_TIMEOUT / 1000}s`));
      } else if (code === 0) {
        resolve();
      } else if (killed && opts.signal?.aborted) {
        reject(new Error("Deployment aborted"));
      } else {
        reject(new Error(`${cmd} failed (exit ${code}): ${stderrBuf.slice(-500)}`));
      }
    });

    proc.on("error", (err) => reject(err));

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, BUILD_TIMEOUT);

    proc.on("close", () => clearTimeout(timeout));
  });
}

type RepoBuildEngine = "dockerfile" | "railpack" | "nixpacks";

/** How many earlier deploys with the same key to look through for an image still on the host. */
const REUSE_LOOKBACK = 10;

/** Tags this app's newest image built with `key` as `imageName`, from the host or else the build registry. Null when neither has it. */
export async function reuseImage(
  ctx: DeployContext,
  key: string,
  imageName: string,
  registry: RegistryOps | null,
): Promise<{ id: string | null; buildPlan: BuildPlanRecord | null } | null> {
  try {
    const rows = await db.query.deployments.findMany({
      where: and(eq(deployments.appId, ctx.appId), eq(deployments.buildKey, key), ne(deployments.id, ctx.deploymentId)),
      orderBy: [desc(deployments.startedAt)],
      limit: REUSE_LOOKBACK,
      columns: { id: true, buildPlan: true },
    });
    const found = await findReusableImage(
      rows.map((r) => ({ id: r.id, image: deploymentImageName(ctx.app.name, r.id) })),
      (image) =>
        execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { env: dockerEnv(), timeout: GIT_METADATA_TIMEOUT })
          .then(() => true, () => false),
    );
    if (found) {
      await execFileAsync("docker", ["tag", found.image, imageName], { env: dockerEnv(), timeout: GIT_METADATA_TIMEOUT });
      return { id: found.id, buildPlan: rows.find((r) => r.id === found.id)?.buildPlan ?? null };
    }
    if (!registry) return null;
    const ref = registry.ref(ctx.app.name, key);
    if (!(await registry.pull(ref))) return null;
    await execFileAsync("docker", ["tag", ref, imageName], { env: dockerEnv(), timeout: GIT_METADATA_TIMEOUT });
    await registry.untag(ref);
    ctx.log(`[build] Pulled ${ref} from the build registry`);
    return { id: null, buildPlan: rows[0]?.buildPlan ?? null };
  } catch (err) {
    ctx.log(`[build] Couldn't reuse an earlier image, building: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Records a repo build as the build phase from the builder's admission, with BuildKit's export split out as in compose builds. */
async function timedBuild(ctx: DeployContext, run: (capture: { text: string }) => Promise<void>): Promise<void> {
  const capture = { text: "" };
  const began = Date.now();
  const waitedBefore = ctx.timer.waited();
  // Admitted after any wait for the builder.
  const admitted = () => began + ctx.timer.waited() - waitedBefore;
  try {
    await run(capture);
  } catch (err) {
    ctx.timer.range("build", admitted(), Date.now());
    throw err;
  }
  const start = admitted();
  const end = Date.now();
  ctx.placement?.built({ contextBytes: contextBytesFromBuildOutput(capture.text) });
  const exportMs = Math.min(exportMsFromBuildOutput(capture.text), end - start);
  ctx.timer.range("build", start, end - exportMs);
  if (exportMs > 0) ctx.timer.range("export", end - exportMs, end);
}

/** A Nixpacks build on the daemon, outside BuildKit's limit. */
const DAEMON_BUILD: BoundedBuild = { env: {}, loadArgs: [], limitBytes: null };

type RepoBuild = {
  repoPath: string;
  imageName: string;
  engine: RepoBuildEngine;
  logs: { push: (line: string) => void };
  envVars: Record<string, string>;
  dockerfilePath?: string;
  cacheKey: string;
  signal?: AbortSignal;
  overrides?: BuildOverrides;
  noCache: boolean;
  gitSha?: string;
  buildKey?: string;
  /** Collects the build's output for timing. */
  capture?: { text: string };
  /** Queues the build for the builder. */
  gate: BuildGate;
  /** Targets a Dockerfile build may run on, with the build registry ref for its image when there is one. */
  remote?: { targets: BuildTarget[]; ref: string | null } | null;
};

async function buildFromRepo(build: RepoBuild): Promise<void> {
  const { repoPath, imageName, logs, envVars, cacheKey, signal, overrides, noCache } = build;
  // Base images may be private, so builders get registry credentials.
  await withRegistryAuth(async (authEnv) => {
    // App vars reach the builders only through --env; in the process env, LD_PRELOAD or PATH would run repo code here.
    const buildEnv = { ...authEnv };

    if (build.engine === "nixpacks") {
      const generated = await generateNixpacksDockerfile({
        source: repoPath,
        cacheKey,
        envVars,
        overrides,
        log: (line) => logs.push(line),
        signal,
      });
      if (generated) {
        try {
          logs.push(`[build] Building with Nixpacks (generated Dockerfile)...`);
          await dockerBuild({ ...build, dockerfile: generated.dockerfile, buildArgs: generated.buildArgs, gitSha: undefined }, authEnv);
          logs.push(`[build] Nixpacks build complete: ${imageName}`);
        } finally {
          await removeNixpacksDir(repoPath);
        }
        return;
      }
      logs.push(`[build] Building with Nixpacks...`);
      const args = nixpacksBuildArgs(imageName, repoPath, envVars, overrides, noCache);
      await withBuildSlot(build.gate, DAEMON_BUILD, () =>
        spawnStream("nixpacks", args, { cwd: repoPath, env: buildEnv, signal }, logs, "[build][nixpacks]", build.capture),
      );
      logs.push(`[build] Nixpacks build complete: ${imageName}`);
      return;
    }

    if (build.engine === "railpack") {
      // Railpack needs BuildKit; fail fast when it isn't reachable.
      if (!buildEnv.BUILDKIT_HOST) buildEnv.BUILDKIT_HOST = DEFAULT_BUILDKIT_HOST;
      await assertBuildKitReachable(buildEnv.BUILDKIT_HOST, signal);

      logs.push(`[build] Building with Railpack...`);
      const args = railpackBuildArgs(imageName, repoPath, cacheKey, envVars, overrides, noCache);
      const limit = await buildKitLimit(buildEnv.BUILDKIT_HOST);
      try {
        await withBuildSlot(build.gate, limit, () =>
          spawnStream("railpack", args, { cwd: repoPath, env: buildEnv, signal }, logs, "[build][railpack]", build.capture),
        );
      } catch (err) {
        throw explainBuildOom(err, limit);
      }
      logs.push(`[build] Railpack build complete: ${imageName}`);
      return;
    }

    const dfPath = build.dockerfilePath || "Dockerfile";
    logs.push(`[build] Building with Dockerfile (${dfPath})...`);
    await dockerBuild({ ...build, dockerfile: join(repoPath, dfPath), buildArgs: envVars }, authEnv);
    logs.push(`[build] Docker build complete: ${imageName}`);
  });
}

/** `docker build` on the bounded builder when BuildKit runs, else on the daemon. */
async function dockerBuild(
  build: RepoBuild & { dockerfile: string; buildArgs: Record<string, string> },
  authEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const { repoPath, logs, signal } = build;
  const bounded = await boundedBuild(undefined, signal);
  const argsInput = {
    imageName: build.imageName,
    dockerfile: build.dockerfile,
    context: repoPath,
    loadArgs: bounded.loadArgs,
    envVars: build.buildArgs,
    noCache: build.noCache,
    buildKey: build.buildKey,
    gitSha: build.gitSha,
  };
  const args = dockerfileBuildArgs(argsInput);
  const remote = build.remote;
  let ran: BoundedBuild = bounded;
  try {
    await withBuildSlot({ ...build.gate, targets: remote?.targets }, bounded, async ({ target }) => {
      if (!target || !remote) {
        ran = bounded;
        for (const line of bounded.notes ?? []) logs.push(line);
        return spawnStream("docker", args, { cwd: repoPath, env: { ...authEnv, ...bounded.env }, signal }, logs, "[build][docker]", build.capture);
      }
      await onTarget(target, async (session) => {
        const there = remoteEnv(authEnv, session);
        const log = (line: string) => void logs.push(line);
        await withTargetBuilder(target, there, log, async ({ build: targetBuild, compression }) => {
          ran = targetBuild;
          const run = (loadArgs: string[], tag = argsInput.imageName) =>
            spawnStream("docker", dockerfileBuildArgs({ ...argsInput, imageName: tag, loadArgs }), { cwd: repoPath, env: { ...there, ...targetBuild.env }, signal }, logs, "[build][docker]", build.capture);
          const image = { image: build.imageName, ref: remote.ref };
          if (!compression) {
            await run(targetBuild.loadArgs);
            await bringBack([image], { authEnv, session, from: target.name, log, placement: build.gate.placement, signal });
            return;
          }
          await bringDirect([image], {
            authEnv, from: target.name, log, placement: build.gate.placement, signal, compression,
            // A pushed image carries only its registry ref; BuildKit would push every `-t` name too.
            build: ([output]) => run(["--output", output, "--provenance=false", "--sbom=false"], pushedName(output) ?? argsInput.imageName),
          });
        }, { signal });
      });
    });
  } catch (err) {
    throw explainBuildOom(err, ran);
  }
}

export async function prepareRepo(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, logs, envMap, signal } = ctx;
  const orgTrusted = ctx.orgTrusted;
  const systemManaged = ctx.org?.isSystemManaged === true && orgTrusted;
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
  const volumesList = appVolumes.filter((v) => v.persistent && !v.removedAt).map((v) => ({ name: v.name, mountPath: v.mountPath }));
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
      compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted, systemManaged });
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
    // Credentials travel in env config, never in the clone URL.
    const split = splitGitUrl(app.gitUrl);
    let cloneUrl = split.url;
    let credentials: string | null;
    try {
      assertSafeBranch(branch);
      assertSafeGitUrl(cloneUrl);
      await assertGitHostAllowed(cloneUrl);
      credentials = openGitCredentials(app.gitCredentials, app.organizationId) ?? split.credentials;
    } catch (err) {
      throw new DeployBlockedError(err instanceof Error ? err.message : String(err));
    }
    const gitEnv: Record<string, string> = {};
    let sshKeyFile: string | null = null;
    let tokenAuth = false;

    // GitHub App token for github.com URLs without their own credentials.
    if (!credentials && cloneUrl.startsWith("https://github.com/")) {
      try {
        const installations = await orgInstallations(ctx.organizationId);
        const installToken = await resolveCloneToken(cloneUrl, installations, {
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
      if (!tokenAuth) {
        const repo = parseGithubRepo(cloneUrl);
        log(`[deploy] No GitHub App installation linked to this organization covers ${repo ? `${repo.owner}/${repo.repo}` : "the repo"}; cloning without a token`);
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

    if (credentials && !tokenAuth && !sshKeyFile) {
      Object.assign(gitEnv, credentialGitEnv(cloneUrl, credentials));
      tokenAuth = true;
    }

    const { readHostConfig, applyHostConfig } = await import("@/lib/config/host-config");

    // Every environment fetches into this checkout; one deploy at a time until its build tree is written.
    let checkoutLock: CheckoutLock;
    try {
      checkoutLock = await acquireCheckoutLock(ctx.appId, { log, signal, wait: ctx.wait });
    } catch (err) {
      if (sshKeyFile) await cleanupKeyFile(sshKeyFile);
      throw err;
    }
    let hostConfig: HostConfig | null = null;
    try {
      try {
        const execOpts = { timeout: GIT_CLONE_TIMEOUT, env: { ...process.env, ...gitEnv } };
        try {
          await execFileAsync("git", ["-C", repoDir, "remote", "set-url", "--", "origin", cloneUrl], execOpts);
          await execFileAsync("git", ["-C", repoDir, ...GIT_NO_REDIRECT, ...branchFetchArgs(branch)], execOpts);
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
                "run", "--rm", "--log-driver", "none", "-v", `${repoDir}:/target`, "alpine",
                "sh", "-c", `rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; chown ${APP_UID}:${APP_UID} /target`,
              ], { env: dockerEnv(), timeout: DOCKER_CLEANUP_TIMEOUT });
            } else {
              throw rmErr;
            }
          }
          try {
            await execFileAsync("git", [...GIT_NO_REDIRECT, "clone", "--depth", "1", "--branch", branch, "--", cloneUrl, repoDir], execOpts);
          } catch (cloneErr) {
            if (tokenAuth || sshKeyFile || !cloneUrl.startsWith("https://github.com/")) throw cloneErr;
            const detail = (cloneErr as { stderr?: string }).stderr?.trim() || (cloneErr instanceof Error ? cloneErr.message : String(cloneErr));
            throw new Error(`Couldn't clone ${cloneUrl} without a GitHub token: ${detail}\n${LINK_INSTALLATION_HINT}`);
          }
          log(`[deploy] Cloned repo (${branch})`);
        }

        // Rollback deploys ship the target commit, not the branch tip.
        if (ctx.rollback) {
          if (!ctx.rollback.gitSha) {
            throw new DeployBlockedError(
              `Rollback target ${ctx.rollback.targetDeploymentId} has no recorded git SHA — cannot roll back to it`,
            );
          }
          await checkoutCommit(
            (args) => execFileAsync("git", ["-C", repoDir, ...GIT_NO_REDIRECT, ...args], execOpts),
            ctx.rollback.gitSha,
            "rollback",
            log,
          );
        } else if (ctx.pinnedGitSha) {
          await checkoutCommit(
            (args) => execFileAsync("git", ["-C", repoDir, ...GIT_NO_REDIRECT, ...args], execOpts),
            ctx.pinnedGitSha,
            ctx.pinIntent ?? "pin",
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
        const { stdout: meta } = await execFileAsync("git", ["-C", repoDir, "log", "-1", "--format=%an%x00%s"], { timeout: GIT_METADATA_TIMEOUT });
        const gitSha = sha.trim();
        const [author, ...subject] = meta.trim().split("\0");
        const gitMessage = subject.join(" ").trim();
        log(`[deploy] Commit: ${gitSha.slice(0, 7)} ${gitMessage}`);
        ctx.gitSha = gitSha;
        ctx.gitMessage = gitMessage;
        ctx.gitAuthor = author || undefined;
        await db
          .update(deployments)
          .set({ gitSha, gitMessage })
          .where(eq(deployments.id, ctx.deploymentId));
      } catch { /* not critical */ }

      hostConfig = await readHostConfig(repoDir);
      if (ctx.gitSha) {
        ctx.buildSourceDir = await writeBuildSource(ctx, repoDir, ctx.gitSha, hostConfig).catch((err) => {
          log(`[build] Warning: couldn't write the build tree, building from the checkout: ${err instanceof Error ? err.message : err}`);
          return undefined;
        });
      }
    } finally {
      await checkoutLock.release();
    }

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
        volumesList.push(...refreshed.filter((v) => v.persistent && !v.removedAt).map((v) => ({ name: v.name, mountPath: v.mountPath })));
        log(`[deploy] host.toml: ${applied.persistentVolumes.length} volume(s)`);
      }
    }

    // Builds and the files that pick the build engine read the build tree, never the shared checkout.
    const srcDir = ctx.buildSourceDir ?? repoDir;
    const root = appRootDir(srcDir, app.rootDirectory || hostConfig?.project?.rootDirectory);
    let composeContent: string | null = null;
    if (app.deployType === "compose") {
      for (const candidate of composeCandidates(app.composeFilePath)) {
        const path = repoFilePath(srcDir, root, candidate);
        try {
          composeContent = await readFile(path, "utf-8");
          log(`[deploy] Found ${candidate}`);
          break;
        } catch { /* try next */ }
      }
    }

    ctx.stage("clone", "success");
    ctx.stage("compose", "running");

    if (composeContent && app.deployType === "compose") {
      compose = parseAndSanitize(composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted, systemManaged });
      await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
    } else {
      // Build from repo: Dockerfile, Railpack or Nixpacks.
      const imageName = deploymentImageName(app.name, ctx.deploymentId);
      let buildType = app.deployType;
      let markers: ProviderMarker[] | undefined;

      if (buildType === "compose" && !composeContent) {
        const dockerfileToCheck = app.dockerfilePath || "Dockerfile";
        const dockerfile = repoFilePath(srcDir, root, dockerfileToCheck);
        try {
          await readFile(dockerfile, "utf-8");
          buildType = "dockerfile";
          log(`[deploy] No compose file, found ${dockerfileToCheck}`);
        } catch {
          markers = await providerMarkers(root);
          const found = markers.length > 0
            ? `found ${describeMarkers(markers)}`
            : "found no language manifest";
          // Prefer Railpack when the opt-in BuildKit daemon is reachable.
          const buildKitHost = process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST;
          if (app.buildProvider) {
            buildType = app.buildProvider;
            log(`[deploy] No compose file or Dockerfile, ${found} — building with ${ENGINE_NAME[buildType]} (set in build settings)`);
          } else if (await isBuildKitReachable(buildKitHost, ctx.signal)) {
            buildType = "railpack";
            log(`[deploy] No compose file or Dockerfile, ${found} — building with Railpack (BuildKit reachable)`);
          } else {
            buildType = "nixpacks";
            log(`[deploy] No compose file or Dockerfile, ${found} — building with Nixpacks (BuildKit not reachable)`);
          }
        }
      }

      if (buildType === "dockerfile") repoFilePath(srcDir, root, app.dockerfilePath || "Dockerfile");
      const preventiveFixes = await detectPreventiveFixes(root, srcDir);
      if (preventiveFixes.length > 0) {
        for (const fix of preventiveFixes) {
          log(`[compat] ${fix.name}: ${fix.description}`);
        }
        Object.assign(envMap, applyCompatFixes(envMap, preventiveFixes));
      }

      ctx.stage("compose", "success");
      ctx.stage("build", "running");

      const customDockerfile = app.dockerfilePath && app.dockerfilePath !== "Dockerfile" ? app.dockerfilePath : undefined;
      const overrides: BuildOverrides = { buildCommand: app.buildCommand, startCommand: app.startCommand };
      const engine = buildType as RepoBuildEngine;
      const keyFor = async () =>
        ctx.gitSha
          ? buildKey({
              appId: ctx.appId,
              gitSha: ctx.gitSha,
              rootDirectory: app.rootDirectory || hostConfig?.project?.rootDirectory || "",
              engine,
              engineVersion: await engineVersion(engine),
              dockerfilePath: app.dockerfilePath,
              buildCommand: app.buildCommand ?? null,
              startCommand: app.startCommand ?? null,
              buildArgs: envMap,
              withGitDir: ctx.buildSourceHasGit === true,
            })
          : undefined;
      let key = await keyFor();
      const registry = key ? await buildRegistryOps(log, signal) : null;
      const targets = await configuredTargets();
      const reused = key && !ctx.rebuild ? await reuseImage(ctx, key, imageName, registry) : null;

      if (reused) {
        log(reused.id
          ? `[build] Reused image from deploy ${reused.id.slice(0, 8)}, nothing build-relevant changed`
          : `[build] Reused the build registry's image, nothing build-relevant changed`);
        if (reused.buildPlan) {
          await db.update(deployments).set({ buildPlan: reused.buildPlan }).where(eq(deployments.id, ctx.deploymentId))
            .catch(() => log(`[build] Couldn't save the build plan`));
        }
      } else {
        if (ctx.rebuild) log(`[build] ${ctx.rebuild === "no-cache" ? "Rebuilding without the build cache" : "Rebuilding"}, as asked`);
        if (buildType === "railpack" || buildType === "nixpacks") {
          const plan = await captureBuildPlan(buildType, root, {
            envVars: envMap,
            overrides,
            markers: markers ?? (await providerMarkers(root)),
            log,
            signal,
          });
          if (plan) {
            for (const line of buildPlanLogLines(plan)) log(line);
            await db.update(deployments).set({ buildPlan: plan }).where(eq(deployments.id, ctx.deploymentId))
              .catch(() => log(`[build] Couldn't save the build plan`));
          }
        }
        const run = () => timedBuild(ctx, (capture) => buildFromRepo({
          repoPath: root,
          imageName,
          engine,
          logs,
          envVars: envMap,
          dockerfilePath: customDockerfile,
          cacheKey: ctx.appId,
          signal,
          gate: { deploymentId: ctx.deploymentId, log, wait: ctx.wait, signal, deploySlot: ctx.deploySlot, placement: ctx.placement },
          overrides,
          noCache: ctx.rebuild === "no-cache",
          gitSha: ctx.gitSha,
          buildKey: key,
          capture,
          remote: targets.length > 0 ? { targets, ref: registry && key ? registry.ref(app.name, key) : null } : null,
        }));
        try {
          await run();
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
            key = await keyFor();
            await run();
          } else {
            throw buildErr;
          }
        }
        ctx.placement?.built({ imageBytes: await imagesBytes([imageName]) });
      }

      if (key) {
        ctx.buildKey = key;
        await db.update(deployments).set({ buildKey: key }).where(eq(deployments.id, ctx.deploymentId))
          .catch(() => log(`[build] Couldn't save the build key; the next deploy rebuilds`));
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
    compose = parseAndSanitize(app.composeContent, log, { allowBindMounts: projectAllowBindMounts, allowDockerSocket: projectAllowDockerSocket, orgTrusted, systemManaged });
    log(`[deploy] Parsed compose content`);
    await detectAndPersistComposeVolumes(compose, ctx.appId, ctx.organizationId, new Set(appVolumes.map(v => v.name)), log);
  } else {
    throw new Error("No image, git repo, or compose content configured");
  }

  const profiles = await activeComposeProfiles(app.name, envMap);
  const applied = applyComposeProfiles(compose, profiles);
  if (applied.skipped.length > 0) {
    log(`[deploy] Skipped ${applied.skipped.join(", ")}: no active profile (COMPOSE_PROFILES=${[...profiles!].join(",")})`);
    for (const name of applied.skipped) {
      const service = compose.services[name];
      if (!service.container_name || !(await isContainerRunning(service.container_name))) continue;
      log(
        `[deploy] Warning: ${service.container_name} is running, but deploys leave it on its old definition while ` +
          `COMPOSE_PROFILES leaves out ${service.profiles?.join(" or ")}`,
      );
    }
  }

  ctx.compose = applied.compose;
  ctx.profileSkipped = applied.skipped;
  return ctx;
}

async function isContainerRunning(container: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", container], {
      env: dockerEnv(),
      timeout: DOCKER_CLEANUP_TIMEOUT,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** COMPOSE_PROFILES for this app: the host .env for Vardo itself, else the app's env. */
async function activeComposeProfiles(appName: string, envMap: Record<string, string>): Promise<Set<string> | null> {
  if (!isSelfApp(appName)) return parseComposeProfiles(envMap.COMPOSE_PROFILES);
  return parseComposeProfiles((await globalEnvValue("COMPOSE_PROFILES")) ?? process.env.COMPOSE_PROFILES ?? "production");
}

