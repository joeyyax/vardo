import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { deployments, apps, orgEnvVars, organizations, environments, volumes, projects } from "@/lib/db/schema";
import { encrypt, decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { resolveAllEnvVars, type ResolveContext } from "@/lib/env/resolve";
import { nanoid } from "nanoid";
import { publishEvent, appChannel } from "@/lib/events";
import { execFile, spawn as nodeSpawn} from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import {
  generateComposeForImage,
  injectTraefikLabels,
  injectNetwork,
  resolveBackendProtocol,
  narrowBackendProtocol,
  injectResourceLimits,
  injectGpuDevices,
  isAnonymousVolume,
  parseCompose,
  sanitizeCompose,
  validateCompose,
  composeToYaml,
  stripTraefikLabels,
  type ComposeFile,
} from "./compose";
import { ensureNetwork, detectExposedPorts, listContainers, inspectContainer, stripDockerProjectPrefix } from "./client";
import { isFeatureEnabled } from "@/lib/config/features";

import { assertSafeName, assertSafeBranch } from "./validate";
import { DeployBlockedError } from "./errors";

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
import { volumeThreshold } from "@/lib/volumes/threshold";
import type { ConfigSnapshot } from "@/lib/types/deploy-snapshot";
import { getInstallationToken } from "@/lib/github/app";
import { githubAppInstallations, memberships } from "@/lib/db/schema";
import { detectPreventiveFixes, detectCompatIssues, applyCompatFixes } from "./compat";
import { syncComposeServices } from "./compose-sync";
import { recordActivity } from "@/lib/activity";
import { regenerateAppRouteConfig, removeAppRouteConfig } from "@/lib/traefik/generate-config";
import {
  getDecryptedPrivateKey,
  writeTemporaryKeyFile,
  cleanupKeyFile,
  buildGitSshCommand,
} from "@/lib/crypto/deploy-key";

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = resolve(process.env.VARDO_PROJECTS_DIR || "./.host/projects");
const NETWORK_NAME = "vardo-network";

const HEALTH_CHECK_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 2000;

export type DeployStage = "clone" | "build" | "deploy" | "healthcheck" | "routing" | "cleanup" | "done";

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
};

export type DeployResult = {
  deploymentId: string;
  success: boolean;
  log: string;
  durationMs: number;
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
  const startTime = Date.now();
  const logLines: string[] = [];

  function log(line: string) {
    // Sanitize secrets from log output
    const sanitized = line
      .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
      .replace(/ghs_[A-Za-z0-9]+/g, "***")
      .replace(/\.host-deploy-key-[A-Za-z0-9_-]+/g, ".host-deploy-key-***");
    logLines.push(sanitized);
    opts.onLog?.(sanitized);

    // Broadcast log line via Redis pub/sub for live viewers
    publishEvent(appChannel(opts.appId), {
      event: "deploy:log",
      appId: opts.appId,
      deploymentId,
      message: sanitized,
    }).catch(() => {});
  }

  function stage(s: DeployStage, status: "running" | "success" | "failed" | "skipped") {
    opts.onStage?.(s, status);

    // Track current stage in Redis so cancel logic can make two-tier decisions.
    // Key expires after 11 minutes (slightly longer than max deploy duration).
    redis.set(`deploy:stage:${opts.appId}`, s, "EX", 660).catch(() => {});

    // Broadcast stage change via Redis pub/sub for live viewers
    publishEvent(appChannel(opts.appId), {
      event: "deploy:stage",
      appId: opts.appId,
      deploymentId,
      stage: s,
      status,
    }).catch(() => {});
  }

  function checkAbort() {
    if (opts.signal?.aborted) throw new Error("Deployment aborted");
  }

  // Proxy for helper functions that expect { push }
  const logs = { push: log };

  try {
    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deploymentId));

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

    // Fetch org once — used for trusted flag and env var resolution later
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, opts.organizationId),
      columns: { id: true, name: true, baseDomain: true, trusted: true },
    });
    const orgTrusted = org?.trusted ?? false;

    // Resolve per-project bind mount permission.
    // Trusted orgs bypass the per-project flag — all bind mounts are allowed.
    let projectAllowBindMounts = false;
    if (orgTrusted) {
      projectAllowBindMounts = true;
    } else if (app.projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, app.projectId),
        columns: { allowBindMounts: true },
      });
      projectAllowBindMounts = project?.allowBindMounts ?? false;
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
    let envBranchOverride: string | null = null;
    if (opts.environmentId) {
      const env = await db.query.environments.findFirst({
        where: eq(environments.id, opts.environmentId),
        columns: { name: true, gitBranch: true },
      });
      if (env) {
        envName = env.name;
        envBranchOverride = env.gitBranch;
      }
    }
    log(`[deploy] Environment: ${envName}`);

    stage("clone", "running");
    log(`[deploy] App: ${app.displayName} (${app.name})`);
    log(`[deploy] Source: ${app.source}, Type: ${app.deployType}`);

    // Load env vars from encrypted blob (gracefully handles unmigrated plaintext)
    const envMap: Record<string, string> = {};
    if (app.envContent) {
      const { content: envText, wasEncrypted } = decryptOrFallback(app.envContent, app.organizationId);
      if (envText) {
        Object.assign(envMap, parseEnvToMap(envText));
        if (!wasEncrypted) {
          log("[deploy] Warning: env vars were not encrypted — auto-encrypting");
          try {
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

    // Ensure PORT is set for Nixpacks-built apps
    if (app.containerPort && !envMap.PORT) {
      envMap.PORT = String(app.containerPort);
    }

    log(`[deploy] ${totalEnvVarCount} env var(s), ${app.domains.length} domain(s)`);

    // Step 1: Generate or fetch compose file
    let compose: ComposeFile;
    let builtLocally = false;
    let hostConfig: import("@/lib/config/host-config").HostConfig | null = null;
    // App-level dir holds the repo; env-level dir holds slots
    const appBaseDir = join(PROJECTS_DIR, app.name);
    const appDir = join(appBaseDir, envName);
    await mkdir(appDir, { recursive: true });

    // Load volumes from the volumes table
    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, opts.appId),
    });
    const volumesList = appVolumes.filter((v) => v.persistent).map((v) => ({ name: v.name, mountPath: v.mountPath }));

    if (app.deployType === "image" && app.imageName) {
      // Image deploy — no clone needed
      stage("clone", "skipped");
      stage("build", "running");
      if (app.composeContent) {
        // Imported container — use the stored compose so bind mounts and other
        // HostConfig options captured at import time are not silently dropped.
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
    } else if (app.source === "git" && app.gitUrl) {
      // Git source — clone/pull repo with GitHub App auth if needed
      // Repo lives at app level (shared across environments)
      const repoDir = join(appBaseDir, "repo");
      const branch = envBranchOverride || app.gitBranch || "main";
      assertSafeBranch(branch);

      // Build authenticated clone URL/env for private repos
      let cloneUrl = app.gitUrl;
      const gitEnv: Record<string, string> = {};
      let sshKeyFile: string | null = null;

      // Strategy 1: GitHub App token (for github.com URLs)
      if (cloneUrl.includes("github.com")) {
        try {
          // Find a GitHub installation for this org
          const orgMembers = await db.query.memberships.findMany({
            where: eq(memberships.organizationId, opts.organizationId),
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
            // Inject token into URL: https://x-access-token:{token}@github.com/owner/repo.git
            cloneUrl = cloneUrl.replace(
              "https://github.com/",
              `https://x-access-token:${installToken}@github.com/`
            );
          }
        } catch (err) {
          log(`[deploy] Warning: GitHub auth — ${err instanceof Error ? err.message : err}`);
        }
      }

      // Strategy 2: SSH deploy key (for any git URL when app has a key assigned)
      // Used as fallback for GitHub URLs without App token, and as primary for non-GitHub
      if (cloneUrl === app.gitUrl && app.gitKeyId) {
        try {
          const privateKeyPem = await getDecryptedPrivateKey(app.gitKeyId, app.organizationId);
          if (privateKeyPem) {
            sshKeyFile = await writeTemporaryKeyFile(privateKeyPem);
            gitEnv.GIT_SSH_COMMAND = buildGitSshCommand(sshKeyFile);

            // Convert HTTPS URL to SSH if needed for key-based auth
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
        const execOpts = { timeout: 60000, env: { ...process.env, ...gitEnv } };
        try {
          // Try pull first (faster if already cloned)
          await execFileAsync("git", ["-C", repoDir, "remote", "set-url", "origin", cloneUrl], execOpts);
          await execFileAsync("git", ["-C", repoDir, "fetch", "origin", branch], execOpts);
          await execFileAsync("git", ["-C", repoDir, "reset", "--hard", `origin/${branch}`], execOpts);
          log(`[deploy] Pulled latest from ${branch}`);
        } catch {
          // Remove stale repo directory left behind by a previously failed clone
          await rm(repoDir, { recursive: true, force: true });
          // Fresh clone
          await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, repoDir], execOpts);
          log(`[deploy] Cloned repo (${branch})`);
        }
      } finally {
        // Always clean up temporary SSH key file
        if (sshKeyFile) {
          await cleanupKeyFile(sshKeyFile);
        }
      }

      // Capture git SHA + commit message
      try {
        const { stdout: sha } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], { timeout: 5000 });
        const { stdout: msg } = await execFileAsync("git", ["-C", repoDir, "log", "-1", "--format=%s"], { timeout: 5000 });
        const gitSha = sha.trim();
        const gitMessage = msg.trim();
        log(`[deploy] Commit: ${gitSha.slice(0, 7)} ${gitMessage}`);
        await db
          .update(deployments)
          .set({ gitSha, gitMessage })
          .where(eq(deployments.id, deploymentId));
      } catch { /* not critical */ }

      // Read host.toml config if present
      const { readHostConfig, applyHostConfig } = await import("@/lib/config/host-config");
      hostConfig = await readHostConfig(repoDir);
      if (hostConfig) {
        const applied = applyHostConfig(hostConfig);
        log(`[deploy] Found host.toml`);
        // Apply config-as-code settings
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
          // Insert host.toml volumes into the volumes table
          for (const vol of applied.persistentVolumes) {
            await db.insert(volumes).values({
              id: nanoid(),
              appId: opts.appId,
              organizationId: opts.organizationId,
              name: vol.name,
              mountPath: vol.mountPath,
              persistent: true,
            }).onConflictDoNothing();
          }
          // Refresh the volumes list so compose generation picks them up
          const refreshed = await db.query.volumes.findMany({
            where: eq(volumes.appId, opts.appId),
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

      // Only look for compose files when deploy type is "compose" (auto-detect)
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

      stage("clone", "success");
      stage("build", "running");

      if (composeContent && app.deployType === "compose") {
        compose = parseAndSanitize(composeContent, log, { allowBindMounts: projectAllowBindMounts, orgTrusted });

        // Detect declared volumes from compose YAML before deploy starts
        if (compose.volumes && Object.keys(compose.volumes).length > 0) {
          const existingNames = new Set(appVolumes.map(v => v.name));
          const newVols: { name: string; mountPath: string }[] = [];

          for (const svc of Object.values(compose.services)) {
            for (const vol of svc.volumes ?? []) {
              const parts = vol.split(":");
              if (parts.length >= 2) {
                const volName = parts[0];
                const mountPath = parts[1];
                if (volName in compose.volumes && !existingNames.has(volName)) {
                  existingNames.add(volName);
                  newVols.push({ name: volName, mountPath });
                }
              }
            }
          }

          if (newVols.length > 0) {
            for (const vol of newVols) {
              await db.insert(volumes).values({
                id: nanoid(),
                appId: opts.appId,
                organizationId: opts.organizationId,
                name: vol.name,
                mountPath: vol.mountPath,
                persistent: true,
              }).onConflictDoNothing();
            }
            log(`[deploy] Detected ${newVols.length} compose volume(s): ${newVols.map(v => `${v.name}:${v.mountPath}`).join(", ")}`);
          }
        }
      } else {
        // Build from repo — Nixpacks, Dockerfile, or auto-detect
        const imageName = `host/${app.name}:${deploymentId.slice(0, 8)}`;
        let buildType = app.deployType;

        // Auto-detect: if deploy type is compose but no compose file found, try Dockerfile then Nixpacks
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
          await buildFromRepo(root, imageName, buildType, logs, envMap, customDockerfile, opts.signal);
        } catch (buildErr) {
          const errMsg = buildErr instanceof Error ? buildErr.message : String(buildErr);

          // If aborted, propagate immediately — no retry
          if (opts.signal?.aborted) throw buildErr;

          // Detect issues from error output and retry with fixes
          const fixes = detectCompatIssues(errMsg);
          if (fixes.length > 0) {
            log(`[compat] Build failed, detected fixable issues:`);
            for (const fix of fixes) {
              log(`[compat]   ${fix.name}: ${fix.description}`);
            }
            log(`[compat] Retrying with fixes applied...`);
            Object.assign(envMap, applyCompatFixes(envMap, fixes));
            await buildFromRepo(root, imageName, buildType, logs, envMap, customDockerfile, opts.signal);
          } else {
            throw buildErr;
          }
        }

        builtLocally = true;
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

      // Detect declared volumes from compose YAML before deploy starts
      if (compose.volumes && Object.keys(compose.volumes).length > 0) {
        const existingNames = new Set(appVolumes.map(v => v.name));
        const newVols: { name: string; mountPath: string }[] = [];

        for (const svc of Object.values(compose.services)) {
          for (const vol of svc.volumes ?? []) {
            const parts = vol.split(":");
            if (parts.length >= 2) {
              const volName = parts[0];
              const mountPath = parts[1];
              if (volName in compose.volumes && !existingNames.has(volName)) {
                existingNames.add(volName);
                newVols.push({ name: volName, mountPath });
              }
            }
          }
        }

        if (newVols.length > 0) {
          for (const vol of newVols) {
            await db.insert(volumes).values({
              id: nanoid(),
              appId: opts.appId,
              organizationId: opts.organizationId,
              name: vol.name,
              mountPath: vol.mountPath,
              persistent: true,
            }).onConflictDoNothing();
          }
          log(`[deploy] Detected ${newVols.length} compose volume(s): ${newVols.map(v => `${v.name}:${v.mountPath}`).join(", ")}`);
        }
      }
    } else {
      throw new Error("No image, git repo, or compose content configured");
    }

    if (app.cpuLimit || app.memoryLimit) {
      compose = injectResourceLimits(compose, { cpuLimit: app.cpuLimit, memoryLimit: app.memoryLimit });
    }

    if (app.gpuEnabled) {
      compose = injectGpuDevices(compose);
    }

    // Step 2: Detect container port
    let detectedPort: number | null = null;

    // Priority: app config > image inspection > PORT env > default
    if (app.containerPort) {
      detectedPort = app.containerPort;
    } else if (builtLocally) {
      // Inspect the built image for EXPOSE'd ports
      try {
        const imageName = Object.values(compose.services)[0]?.image;
        if (imageName) {
          const ports = await detectExposedPorts(imageName);
          if (ports.length > 0) {
            detectedPort = ports[0];
            log(`[deploy] Detected port from image: ${detectedPort}`);
          }
        }
      } catch { /* inspection failed, fall through */ }
    }

    if (!detectedPort && envMap.PORT) {
      detectedPort = parseInt(envMap.PORT);
    }

    const containerPort = detectedPort || 3000;
    if (!app.containerPort) {
      log(`[deploy] Using port ${containerPort}${detectedPort ? " (auto-detected)" : " (default)"}`);
    }

    // Step 3: Inject Traefik labels + shared network
    // Check if any service uses a custom network mode (host, service:X, container:X)
    const servicesWithCustomNetwork = Object.entries(compose.services)
      .filter(([, svc]) => svc.network_mode && svc.network_mode !== "bridge")
      .map(([name, svc]) => `${name} (${svc.network_mode})`);
    const allServicesCustomNetwork = servicesWithCustomNetwork.length === Object.keys(compose.services).length;

    if (!allServicesCustomNetwork) {
      // Strip stale Traefik labels from the stored compose before re-injecting.
      // The stored compose may contain router names from a prior import or deploy
      // (e.g. "appname" from import vs "appname-abc123" from deploy) — clear them
      // all so we don't end up with duplicate routers pointing at the same domain.
      compose = stripTraefikLabels(compose);

      // Find the first bridge-network service in compose file order (Object.keys preserves
      // insertion order for string keys, matching the order services appear in the compose file).
      // This ensures Traefik labels target a service reachable on vardo-network rather than
      // a host-network, service:X, or container:X service that Traefik can't reach.
      const primaryServiceName = Object.keys(compose.services).find(
        (k) => !compose.services[k].network_mode || compose.services[k].network_mode === "bridge"
      );
      const narrowedProtocol = narrowBackendProtocol(app.backendProtocol);
      for (const domain of app.domains) {
        const port = domain.port || containerPort;
        const resolvedProtocol = resolveBackendProtocol(
          narrowedProtocol,
          port,
        );
        compose = injectTraefikLabels(compose, {
          projectName: `${app.name}-${domain.id.slice(0, 6)}`,
          appName: app.name,
          domain: domain.domain,
          containerPort: port,
          certResolver: domain.certResolver || "le",
          ssl: domain.sslEnabled ?? true,
          redirectTo: domain.redirectTo ?? undefined,
          redirectCode: domain.redirectCode ?? 301,
          serviceName: primaryServiceName,
          backendProtocol: resolvedProtocol,
        });
        if (domain.redirectTo) {
          log(`[deploy] Traefik: ${domain.domain} → redirect ${domain.redirectCode ?? 301} ${domain.redirectTo}`);
        } else {
          log(`[deploy] Traefik: ${domain.domain} → :${port}${(domain.sslEnabled ?? true) ? " (TLS)" : ""}`);
        }
      }

      regenerateAppRouteConfig(app.id).catch((err) =>
        log(`[deploy] Warning: failed to write Traefik dynamic config — ${err}`)
      );
    } else {
      log(`[deploy] Skipping Traefik labels — all services use custom network modes: ${servicesWithCustomNetwork.join(", ")}`);
      removeAppRouteConfig(app.name).catch(() => {});
    }
    compose = injectNetwork(compose, NETWORK_NAME);

    // Step 3: Add app labels
    // These are written after the spread of any stored labels, so they
    // unconditionally overwrite any vardo.* values that came through the import
    // filter (compose.ts). That overwrite is the security boundary — an imported
    // container's labels cannot spoof organization, project.id, managed, etc.
    // If the spread order ever changes, that guarantee breaks.
    for (const [svcName, svc] of Object.entries(compose.services)) {
      compose.services[svcName] = {
        ...svc,
        labels: {
          ...svc.labels,
          "vardo.project": app.name,
          "vardo.project.id": app.id,
          "vardo.organization": opts.organizationId,
          "vardo.deployment.id": deploymentId,
          "vardo.environment": envName,
          "vardo.managed": "true",
        },
      };
    }

    // Step 4: Blue-green slot management
    let activeSlot: "blue" | "green" | null = null;
    try {
      const slotFile = await readFile(join(appDir, ".active-slot"), "utf-8");
      activeSlot = slotFile.trim() as "blue" | "green";
    } catch { /* no active slot yet */ }

    const newSlot = activeSlot === "blue" ? "green" : "blue";
    const newProjectName = `${app.name}-${envName}-${newSlot}`;
    const slotDir = join(appDir, newSlot);
    await mkdir(slotDir, { recursive: true });

    checkAbort();
    stage("build", "success");
    stage("deploy", "running");
    log(`[deploy] Active slot: ${activeSlot || "none"}, deploying to: ${newSlot}`);

    // Step 5: Write compose file (without Traefik labels — new container starts but doesn't receive traffic)
    const composePath = join(slotDir, "docker-compose.yml");
    await writeFile(composePath, composeToYaml(compose), "utf-8");

    // Write .env — resolve template expressions using the full resolution engine
    if (Object.keys(envMap).length > 0) {
      // Load org-level shared env vars
      const orgVarRows = await db.query.orgEnvVars.findMany({
        where: eq(orgEnvVars.organizationId, opts.organizationId),
      });
      const orgEnvVarMap: Record<string, string> = {};
      for (const v of orgVarRows) {
        if (v.isSecret) {
          const { content, decryptFailed } = decryptOrFallback(v.value, opts.organizationId);
          if (decryptFailed) {
            // The value is encrypted but decryption failed — wrong key or corrupted data.
            // Abort the deploy rather than silently injecting an empty credential.
            throw new Error(
              `[deploy] Failed to decrypt org env var '${v.key}' — wrong key or corrupted data. Deploy aborted.`
            );
          }
          orgEnvVarMap[v.key] = content;
        } else {
          orgEnvVarMap[v.key] = v.value;
        }
      }

      const primaryDomain = app.domains[0]?.domain ?? null;

      const resolveCtx: ResolveContext = {
        project: {
          id: app.id,
          name: app.name,
          displayName: app.displayName,
          containerPort: app.containerPort,
          domain: primaryDomain,
          gitUrl: app.gitUrl,
          gitBranch: app.gitBranch,
          imageName: app.imageName,
        },
        org: {
          id: opts.organizationId,
          name: org?.name ?? "",
          baseDomain: org?.baseDomain ?? null,
        },
        envVars: envMap,
        orgEnvVars: orgEnvVarMap,
        resolveExternalVar: async (appName: string, varKey: string) => {
          // Find the referenced app in the same org
          const refApp = await db.query.apps.findFirst({
            where: and(
              eq(apps.organizationId, opts.organizationId),
              eq(apps.name, appName),
            ),
            columns: {
              id: true,
              name: true,
              displayName: true,
              organizationId: true,
              projectId: true,
              containerPort: true,
              gitUrl: true,
              gitBranch: true,
              imageName: true,
              envContent: true,
            },
            with: { domains: { columns: { domain: true }, limit: 1 } },
          });
          if (!refApp) return null;

          // Check built-in app fields first
          const builtinFields: Record<string, string | null> = {
            name: refApp.name,
            displayName: refApp.displayName,
            port: refApp.containerPort?.toString() ?? null,
            id: refApp.id,
            domain: refApp.domains[0]?.domain ?? null,
            url: refApp.domains[0]?.domain
              ? `https://${refApp.domains[0].domain}`
              : null,
            host: refApp.domains[0]?.domain ?? null,
            internalHost: refApp.name,
            gitUrl: refApp.gitUrl,
            gitBranch: refApp.gitBranch,
            imageName: refApp.imageName,
          };
          if (varKey in builtinFields) return builtinFields[varKey];

          // If the referenced app is in the same project AND we have a
          // groupEnvironmentId, try to resolve from the matching environment
          if (
            opts.groupEnvironmentId &&
            refApp.projectId &&
            app.projectId &&
            refApp.projectId === app.projectId
          ) {
            // Find the environment on the referenced app that belongs
            // to the same group environment
            const refEnv = await db.query.environments.findFirst({
              where: and(
                eq(environments.appId, refApp.id),
                eq(environments.groupEnvironmentId, opts.groupEnvironmentId),
              ),
              columns: { id: true },
            });

            if (refEnv) {
              // Environment-specific resolution would go here
              // For now, fall through to base env content
            }
          }

          // Decrypt the referenced app's env content and look up the key
          if (!refApp.envContent) return null;
          const { content: refText } = decryptOrFallback(refApp.envContent, refApp.organizationId);
          if (!refText) return null;
          const refMap = parseEnvToMap(refText);
          return refMap[varKey] ?? null;
        },
      };

      const resolved = await resolveAllEnvVars(envMap, resolveCtx);
      const envContent = Object.entries(resolved).map(([k, v]) => {
        // Quote values containing newlines, quotes, spaces, $, or # to prevent injection
        if (/[\n\r"' $#\\]/.test(v)) {
          return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
        }
        return `${k}=${v}`;
      }).join("\n");
      await writeFile(join(slotDir, ".env"), envContent, "utf-8");
    }

    // Step 6: Ensure network
    try {
      await ensureNetwork(NETWORK_NAME);
    } catch (err) {
      log(`[deploy] Warning: network — ${err instanceof Error ? err.message : err}`);
    }

    // Step 7: Pull and start new slot (no traffic yet)
    // Use --pull missing for locally-built images, --pull always for remote
    const pullPolicy = builtLocally ? "missing" : "always";
    log(`[deploy] Starting ${newSlot} slot...`);
    try {
      const { stdout, stderr } = await execFileAsync(
        "docker",
        ["compose", "-f", composePath, "-p", newProjectName, "up", "-d", "--pull", pullPolicy],
        { cwd: slotDir, timeout: 120000 }
      );
      if (stdout.trim()) logs.push(`[deploy][compose] ${stdout.trim()}`);
      if (stderr.trim()) logs.push(`[deploy][compose] ${stderr.trim()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`docker compose up (${newSlot}) failed: ${message}`);
    }

    // Step 8: Health check — wait for new slot to be ready
    checkAbort();
    stage("deploy", "success");
    stage("healthcheck", "running");
    log(`[deploy] Waiting for ${newSlot} to be healthy...`);
    const healthy = await waitForHealthy(newProjectName, composePath, slotDir, logs);
    if (!healthy) {
      // Grab container logs before tearing down
      log(`[deploy] Health check failed — fetching container logs...`);
      try {
        const { stdout } = await execFileAsync(
          "docker",
          ["compose", "-f", composePath, "-p", newProjectName, "logs", "--tail", "30"],
          { cwd: slotDir, timeout: 10000 }
        );
        if (stdout.trim()) {
          for (const line of stdout.trim().split("\n")) {
            log(`[deploy][crash] ${line}`);
          }
        }
      } catch { /* couldn't get logs */ }

      log(`[deploy] Tearing down ${newSlot}`);
      await execFileAsync(
        "docker",
        ["compose", "-f", composePath, "-p", newProjectName, "down", "--remove-orphans"],
        { cwd: slotDir, timeout: 30000 }
      ).catch(() => {});
      throw new Error(`${newSlot} slot did not become healthy — container may have crashed (see logs above)`);
    }
    stage("healthcheck", "success");
    stage("routing", "running");
    log(`[deploy] ${newSlot} healthy`);

    // Step 9: Traffic is already routed — labels were included from the start
    // Traefik discovers the container via labels on the Docker network
    log(`[deploy] Traffic routed to ${newSlot}`);
    stage("routing", "success");
    stage("cleanup", "running");
    // Step 10: Tear down old slot
    if (activeSlot) {
      const oldSlotDir = join(appDir, activeSlot);
      const oldProjectName = `${app.name}-${envName}-${activeSlot}`;
      const oldComposePath = join(oldSlotDir, "docker-compose.yml");
      try {
        await execFileAsync(
          "docker",
          ["compose", "-f", oldComposePath, "-p", oldProjectName, "down", "--remove-orphans"],
          { cwd: oldSlotDir, timeout: 30000 }
        );
        log(`[deploy] Old slot (${activeSlot}) removed`);
      } catch (err) {
        log(`[deploy] Warning: old slot cleanup — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 11: Record active slot
    await writeFile(join(appDir, ".active-slot"), newSlot, "utf-8");

    stage("cleanup", "success");
    // Step 12: HTTP health check on domains
    for (const domain of app.domains) {
      const ok = await checkEndpoint(domain.domain, logs);
      if (ok) logs.push(`[health] ${domain.domain} responding`);
      else logs.push(`[health] ${domain.domain} not yet reachable (DNS/TLS propagation)`);
    }

    stage("done", "success");
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
        // Re-fetch current volumes from the table (may have been updated during deploy)
        const currentVolumes = await db.query.volumes.findMany({
          where: eq(volumes.appId, opts.appId),
        });
        const existingPaths = new Set(currentVolumes.map((v) => v.mountPath));
        const newDetected = detectedVolumes.filter((v) => !existingPaths.has(v.mountPath));

        if (newDetected.length > 0) {
          for (const vol of newDetected) {
            await db.insert(volumes).values({
              id: nanoid(),
              appId: opts.appId,
              organizationId: opts.organizationId,
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

    // Auto-create backup job for apps with persistent volumes
    try {
      const { ensureAutoBackupJob } = await import("@/lib/backup/auto-backup");
      const backupJobId = await ensureAutoBackupJob({
        appId: opts.appId,
        appName: app.name,
        organizationId: opts.organizationId,
      });
      if (backupJobId) {
        log(`[deploy] Auto-configured daily backup job for persistent volumes`);
      }
    } catch {
      // Auto-backup is best-effort — don't fail the deploy
    }

    // Check volume size limits (reads limits directly from volume records)
    try {
      const limitedVolumes = await db.query.volumes.findMany({
        where: eq(volumes.appId, opts.appId),
      });
      const anyLimited = limitedVolumes.some((v) => v.maxSizeBytes != null);

      if (anyLimited) {
        const { formatBytes } = await import("@/lib/metrics/format");
        const runningContainers = await listContainers(app.name);

        // Collect all named volumes across containers
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

        // Build a lookup of limit config by volume name
        const limitByName = new Map(
          limitedVolumes
            .filter((v) => v.maxSizeBytes != null)
            .map((v) => [v.name, { maxSizeBytes: v.maxSizeBytes!, warnAtPercent: v.warnAtPercent ?? 80 }])
        );

        // Measure all volumes in parallel
        if (volEntries.length > 0) {
          const results = await Promise.allSettled(
            volEntries.map(({ volName }) =>
              execFileAsync(
                "docker",
                ["run", "--rm", "-v", `${volName}:/data`, "alpine", "du", "-sb", "/data"],
                { timeout: 30000 }
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
      // Re-throw volume limit enforcement errors — they should fail the deploy
      if (err instanceof DeployBlockedError) throw err;
      // Other errors are non-fatal (e.g. Docker not available)
    }

    // Sync cron jobs from template and/or host.toml
    try {
      const { syncCronJobs } = await import("@/lib/cron/engine");
      const cronDefs: { name: string; schedule: string; command: string }[] = [];

      // From host.toml
      if (hostConfig?.cron?.length) {
        cronDefs.push(...hostConfig.cron);
      }

      // From template
      if (app.templateName) {
        const { loadTemplates } = await import("@/lib/templates/load");
        const templates = await loadTemplates();
        const tpl = templates.find(t => t.name === app.templateName);
        if (tpl?.defaultCronJobs?.length) {
          cronDefs.push(...tpl.defaultCronJobs);
        }
      }

      if (cronDefs.length > 0) {
        const created = await syncCronJobs(opts.appId, cronDefs);
        if (created > 0) {
          log(`[deploy] Synced ${created} cron job(s)`);
        }
      }
    } catch (err) {
      log(`[deploy] Warning: cron sync — ${err instanceof Error ? err.message : err}`);
    }

    // Sync compose decomposition: create/update child app records per service
    if (app.deployType === "compose" && Object.keys(compose.services).length > 0) {
      try {
        const syncResult = await syncComposeServices({
          parentAppId: opts.appId,
          organizationId: opts.organizationId,
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
      .where(eq(apps.id, opts.appId));

    // Snapshot current config onto deployment record for rollback
    let envSnapshot: string | null = null;
    if (app.envContent) {
      // Re-encrypt under the same org key — snapshot is always encrypted
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

    const durationMs = Date.now() - startTime;
    await db
      .update(deployments)
      .set({
        status: "success",
        log: logLines.join("\n"),
        durationMs,
        finishedAt: new Date(),
        envSnapshot,
        configSnapshot,
      })
      .where(eq(deployments.id, deploymentId));

    // Publish event for real-time UI updates
    publishEvent(appChannel(opts.appId), {
      event: "deploy:complete",
      status: "active",
      deploymentId,
      success: true,
      durationMs,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.succeeded",
      appId: opts.appId,
      metadata: { deploymentId, durationMs },
    }).catch(() => {});

    // Send success notification (non-blocking)
    sendDeployNotification(app, deploymentId, true, durationMs).catch(() => {});

    // Start auto-rollback monitor if enabled
    if (app.autoRollback && activeSlot) {
      const gracePeriod = app.rollbackGracePeriod ?? 60;
      log(`[deploy] Auto-rollback enabled — monitoring for ${gracePeriod}s`);
      try {
        const { startRollbackMonitor } = await import("./rollback-monitor");
        startRollbackMonitor({
          appId: opts.appId,
          appName: app.name,
          organizationId: opts.organizationId,
          deploymentId,
          gracePeriodSeconds: gracePeriod,
          currentSlot: newSlot,
          previousSlot: activeSlot,
          envName,
        });
      } catch (err) {
        log(`[deploy] Warning: rollback monitor — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Post-deploy drift check (non-blocking, purely informational).
    // Wait 10s for containers to settle before scanning volumes.
    setTimeout(() => {
      import("@/lib/volumes/drift-check")
        .then(({ runPostDeployDriftCheck }) =>
          runPostDeployDriftCheck({
            appId: opts.appId,
            organizationId: opts.organizationId,
            appName: app.name,
            log,
          }),
        )
        .catch(() => {});
    }, 10000);
    return { deploymentId, success: true, log: logLines.join("\n"), durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const durationMs = Date.now() - startTime;

    // Check if this deploy was aborted — either superseded by a newer one or killed by the user.
    // The AbortController in deploy-cancel.ts passes { supersededBy } or { killed: true } as the reason.
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason as { supersededBy?: string; killed?: boolean } | undefined;
      const supersededById = reason?.supersededBy;

      if (supersededById) {
        log(`[deploy] Superseded by deployment ${supersededById}`);
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

        publishEvent(appChannel(opts.appId), {
          event: "deploy:superseded",
          appId: opts.appId,
          deploymentId,
          supersededBy: supersededById,
        }).catch(() => {});

        return { deploymentId, success: false, log: logLines.join("\n"), durationMs };
      }

      if (reason?.killed) {
        log(`[deploy] Cancelled by user`);
        await db
          .update(deployments)
          .set({
            status: "cancelled",
            log: logLines.join("\n"),
            durationMs,
            finishedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId));

        publishEvent(appChannel(opts.appId), {
          event: "deploy:complete",
          status: "cancelled",
          deploymentId,
          success: false,
          durationMs,
        }).catch(() => {});

        recordActivity({
          organizationId: opts.organizationId,
          action: "deployment.cancelled",
          appId: opts.appId,
          metadata: { deploymentId },
        }).catch(() => {});

        return { deploymentId, success: false, log: logLines.join("\n"), durationMs };
      }
    }

    log(`[deploy] ERROR: ${message}`);

    await db
      .update(deployments)
      .set({ status: "failed", log: logLines.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    await db
      .update(apps)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(apps.id, opts.appId));

    // Publish event for real-time UI updates
    publishEvent(appChannel(opts.appId), {
      event: "deploy:complete",
      status: "error",
      deploymentId,
      success: false,
      durationMs,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.failed",
      appId: opts.appId,
      metadata: { deploymentId, error: message },
    }).catch(() => {});

    // Send failure notification (non-blocking) — app may not be fetched yet
    sendDeployNotification(
      { id: opts.appId, name: "", displayName: "", organizationId: opts.organizationId, domains: [] },
      deploymentId, false, durationMs, message
    ).catch(() => {});

    return { deploymentId, success: false, log: logLines.join("\n"), durationMs };
  } finally {
    // Always clean up the Redis stage key for this app
    redis.del(`deploy:stage:${opts.appId}`).catch(() => {});
  }
}

async function sendDeployNotification(
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

      // Post-deploy security probe — delayed to allow the app to become ready
      if (domain) {
        const probeDomain = domain;
        setTimeout(async () => {
          try {
            const { checkFileExposure } = await import("@/lib/security/file-exposure");
            const exposed = await checkFileExposure(probeDomain);
            if (exposed.length > 0) {
              emit(app.organizationId!, {
                type: "security.file-exposed",
                title: `Exposed files detected: ${projectName}`,
                message: `${exposed.length} sensitive file(s) publicly accessible on ${probeDomain}: ${exposed.join(", ")}`,
                appName: projectName,
                domain: probeDomain,
                exposedPaths: exposed,
              });
            }
          } catch { /* probe failure is non-fatal */ }
        }, 10_000);
      }
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
// Health checks
// ---------------------------------------------------------------------------

async function buildFromRepo(
  repoPath: string,
  imageName: string,
  deployType: string,
  logs: { push: (line: string) => void },
  envVars?: Record<string, string>,
  dockerfilePath?: string,
  signal?: AbortSignal,
): Promise<void> {
  // Build environment for the child process
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
      // Spawn in its own process group so we can kill(-pid) to terminate
      // the entire tree (e.g. docker build + child processes) on cancel.
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

    // Terminate process group when the abort signal fires
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
        // Killed by abort signal — propagate as an abort error so callers
        // can distinguish cancellation from a genuine build failure.
        reject(new Error("Deployment aborted"));
      } else {
        reject(new Error(`${cmd} failed (exit ${code}): ${stderrBuf.slice(-500)}`));
      }
    });

    proc.on("error", (err) => reject(err));

    // 5 minute timeout
    const timeout = setTimeout(() => {
      killProcessGroup();
      reject(new Error(`${cmd} timed out after 300s`));
    }, 300000);

    proc.on("close", () => clearTimeout(timeout));
  });
}

async function waitForHealthy(
  projectName: string,
  composePath: string,
  cwd: string,
  logs: { push: (line: string) => void }
): Promise<boolean> {
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["compose", "-f", composePath, "-p", projectName, "ps", "--format", "json"],
        { cwd, timeout: 10000 }
      );

      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        await sleep(HEALTH_CHECK_INTERVAL_MS);
        continue;
      }

      let allReady = true;
      for (const line of lines) {
        try {
          const container = JSON.parse(line);
          const state = (container.State || "").toLowerCase();
          const health = (container.Health || "").toLowerCase();

          if (state === "exited" || state === "dead") {
            logs.push(`[health] ${container.Service || container.Name}: ${state}`);
            return false;
          }

          if (health && health !== "healthy") allReady = false;
          else if (!health && state !== "running") allReady = false;
        } catch { /* skip */ }
      }

      if (allReady) return true;
    } catch { /* retry */ }

    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  logs.push(`[health] Timeout after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s`);
  return false;
}

async function checkEndpoint(domain: string, logs: { push: (line: string) => void }): Promise<boolean> {
  const paths = ["/healthz", "/health", "/"];
  const timeout = 5000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Stop / Restart
// ---------------------------------------------------------------------------

async function stopSlotInDir(
  dir: string,
  projectPrefix: string,
  logs: string[],
): Promise<void> {
  let activeSlot: string;
  try {
    activeSlot = (await readFile(join(dir, ".active-slot"), "utf-8")).trim();
  } catch {
    activeSlot = "blue";
  }

  const slotDir = join(dir, activeSlot);
  const composePath = join(slotDir, "docker-compose.yml");
  const composeProject = `${projectPrefix}-${activeSlot}`;

  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", "-f", composePath, "-p", composeProject, "down"],
      { cwd: slotDir, timeout: 60000 }
    );
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());
  } catch (err) {
    logs.push(`Warning: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function stopProject(
  appId: string,
  appName: string,
  environmentName?: string,
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    if (environmentName) {
      // Stop specific environment
      const envDir = join(PROJECTS_DIR, appName, environmentName);
      await stopSlotInDir(envDir, `${appName}-${environmentName}`, logs);
    } else {
      // Stop all environments — try env-aware layout first
      const baseDir = join(PROJECTS_DIR, appName);
      try {
        const { readdir } = await import("fs/promises");
        const entries = await readdir(baseDir, { withFileTypes: true });
        const envDirs = entries.filter((e) => e.isDirectory() && e.name !== "repo");
        if (envDirs.length > 0) {
          for (const entry of envDirs) {
            // Skip blue/green slot dirs at app root (legacy layout)
            if (entry.name === "blue" || entry.name === "green") {
              await stopSlotInDir(baseDir, appName, logs);
              break;
            }
            const envDir = join(baseDir, entry.name);
            await stopSlotInDir(envDir, `${appName}-${entry.name}`, logs);
          }
        } else {
          // Legacy: slot dirs directly under app
          await stopSlotInDir(baseDir, appName, logs);
        }
      } catch {
        // Fallback to legacy layout
        await stopSlotInDir(baseDir, appName, logs);
      }
    }

    await db
      .update(apps)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(apps.id, appId));

    // Cascade stop status to compose child services
    await db
      .update(apps)
      .set({ status: "stopped", updatedAt: new Date() })
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
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    const dir = environmentName
      ? join(PROJECTS_DIR, appName, environmentName)
      : join(PROJECTS_DIR, appName);
    const prefix = environmentName
      ? `${appName}-${environmentName}`
      : appName;

    let activeSlot: string;
    try {
      activeSlot = (await readFile(join(dir, ".active-slot"), "utf-8")).trim();
    } catch {
      activeSlot = "blue";
    }

    const slotDir = join(dir, activeSlot);
    const composePath = join(slotDir, "docker-compose.yml");
    const composeProject = `${prefix}-${activeSlot}`;

    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", "-f", composePath, "-p", composeProject, "restart"],
      { cwd: slotDir, timeout: 60000 }
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
    const dir = environmentName
      ? join(PROJECTS_DIR, appName, environmentName)
      : join(PROJECTS_DIR, appName);
    const prefix = environmentName
      ? `${appName}-${environmentName}`
      : appName;

    let activeSlot: string;
    try {
      activeSlot = (await readFile(join(dir, ".active-slot"), "utf-8")).trim();
    } catch {
      activeSlot = "blue";
    }

    const slotDir = join(dir, activeSlot);
    const composePath = join(slotDir, "docker-compose.yml");
    const composeProject = `${prefix}-${activeSlot}`;

    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", "-f", composePath, "-p", composeProject, "up", "-d", "--force-recreate"],
      { cwd: slotDir, timeout: 60000 }
    );
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());

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

/** @deprecated Use restartContainers or recreateProject instead */
export async function restartProject(
  appId: string,
  appName: string,
  environmentName?: string,
): Promise<{ success: boolean; log: string }> {
  return recreateProject(appId, appName, environmentName);
}
