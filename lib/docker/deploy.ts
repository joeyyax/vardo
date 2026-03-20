import { db } from "@/lib/db";
import { deployments, projects, envVars, orgEnvVars, organizations, environments } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { resolveAllEnvVars, type ResolveContext } from "@/lib/env/resolve";
import { nanoid } from "nanoid";
import { publishEvent, projectChannel } from "@/lib/events";
import { exec, spawn as nodeSpawn} from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join, resolve } from "path";
import {
  generateComposeForImage,
  injectTraefikLabels,
  injectNetwork,
  parseCompose,
  composeToYaml,
  type ComposeFile,
} from "./compose";
import { ensureNetwork, detectExposedPorts, listContainers, inspectContainer } from "./client";
import { getInstallationToken } from "@/lib/github/app";
import { githubAppInstallations, memberships } from "@/lib/db/schema";
import { detectPreventiveFixes, detectCompatIssues, applyCompatFixes } from "./compat";
import { recordActivity } from "@/lib/activity";

const execAsync = promisify(exec);

const PROJECTS_DIR = resolve(process.env.HOST_PROJECTS_DIR || "./.host/projects");
const NETWORK_NAME = "host-network";
const HEALTH_CHECK_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 2000;

type DeployStage = "clone" | "build" | "deploy" | "healthcheck" | "routing" | "cleanup" | "done";

type DeployOpts = {
  projectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
  triggeredBy?: string;
  environmentId?: string;
  groupEnvironmentId?: string;
  onLog?: (line: string) => void;
  onStage?: (stage: DeployStage, status: "running" | "success" | "failed" | "skipped") => void;
  signal?: AbortSignal;
};

export type { DeployStage };

type DeployResult = {
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
      projectId: opts.projectId,
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
    logLines.push(line);
    opts.onLog?.(line);
  }

  function stage(s: DeployStage, status: "running" | "success" | "failed" | "skipped") {
    opts.onStage?.(s, status);
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
      projectId: opts.projectId,
      userId: opts.triggeredBy,
      metadata: { deploymentId, trigger: opts.trigger },
    }).catch(() => {});

    log(`[deploy] Starting deployment ${deploymentId}`);

    // Fetch project
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, opts.projectId),
        eq(projects.organizationId, opts.organizationId)
      ),
      with: { domains: true },
    });

    if (!project) throw new Error("Project not found");

    stage("clone", "running");
    log(`[deploy] Project: ${project.displayName} (${project.name})`);
    log(`[deploy] Source: ${project.source}, Type: ${project.deployType}`);

    // Fetch env vars with environment layering:
    // 1. Base vars (environmentId IS NULL)
    // 2. Environment-specific vars overlay on top
    const baseVars = await db.query.envVars.findMany({
      where: and(
        eq(envVars.projectId, opts.projectId),
        isNull(envVars.environmentId),
      ),
    });
    const envMap: Record<string, string> = {};
    for (const v of baseVars) envMap[v.key] = v.value;

    if (opts.environmentId) {
      const envSpecificVars = await db.query.envVars.findMany({
        where: and(
          eq(envVars.projectId, opts.projectId),
          eq(envVars.environmentId, opts.environmentId),
        ),
      });
      for (const v of envSpecificVars) envMap[v.key] = v.value;
    }

    const totalEnvVarCount = Object.keys(envMap).length;

    // Ensure PORT is set for Nixpacks-built apps
    if (project.containerPort && !envMap.PORT) {
      envMap.PORT = String(project.containerPort);
    }

    log(`[deploy] ${totalEnvVarCount} env var(s), ${project.domains.length} domain(s)`);

    // Step 1: Generate or fetch compose file
    let compose: ComposeFile;
    let builtLocally = false;
    const projectDir = join(PROJECTS_DIR, project.name);
    await mkdir(projectDir, { recursive: true });

    if (project.deployType === "image" && project.imageName) {
      // Image deploy — no clone needed
      stage("clone", "skipped");
      stage("build", "running");
      const volumes = (project.persistentVolumes as { name: string; mountPath: string }[] | null) ?? undefined;
      const exposedPorts = (project.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null) ?? undefined;
      compose = generateComposeForImage({
        projectName: project.name,
        imageName: project.imageName,
        containerPort: project.containerPort ?? undefined,
        envVars: envMap,
        volumes,
        exposedPorts,
      });
      if (volumes?.length) log(`[deploy] ${volumes.length} persistent volume(s)`);
      if (exposedPorts?.length) log(`[deploy] ${exposedPorts.length} exposed port(s)`);
      log(`[deploy] Generated compose for image: ${project.imageName}`);
    } else if (project.source === "git" && project.gitUrl) {
      // Git source — clone/pull repo with GitHub App auth if needed
      const repoDir = join(projectDir, "repo");
      const branch = project.gitBranch || "main";

      // Build authenticated clone URL for private repos
      let cloneUrl = project.gitUrl;
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

      try {
        // Try pull first (faster if already cloned)
        await execAsync(
          `git -C "${repoDir}" remote set-url origin "${cloneUrl}" && git -C "${repoDir}" fetch origin ${branch} && git -C "${repoDir}" reset --hard origin/${branch}`,
          { timeout: 60000 }
        );
        log(`[deploy] Pulled latest from ${branch}`);
      } catch {
        // Fresh clone
        await execAsync(`git clone --depth 1 --branch ${branch} "${cloneUrl}" "${repoDir}"`, { timeout: 60000 });
        log(`[deploy] Cloned repo (${branch})`);
      }

      // Capture git SHA + commit message
      try {
        const { stdout: sha } = await execAsync(`git -C "${repoDir}" rev-parse HEAD`, { timeout: 5000 });
        const { stdout: msg } = await execAsync(`git -C "${repoDir}" log -1 --format=%s`, { timeout: 5000 });
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
      const hostConfig = await readHostConfig(repoDir);
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
          log(`[deploy] host.toml: ${applied.persistentVolumes.length} volume(s)`);
        }
      }

      // Find compose file
      const root = project.rootDirectory
        ? join(repoDir, project.rootDirectory)
        : hostConfig?.project?.rootDirectory
        ? join(repoDir, hostConfig.project.rootDirectory)
        : repoDir;
      const composeFilePath = project.composeFilePath || "docker-compose.yml";
      const composeCandidates = [
        composeFilePath,
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
      ];

      let composeContent: string | null = null;
      for (const candidate of composeCandidates) {
        try {
          composeContent = await readFile(join(root, candidate), "utf-8");
          log(`[deploy] Found ${candidate}`);
          break;
        } catch { /* try next */ }
      }

      stage("clone", "success");
      stage("build", "running");

      if (composeContent && project.deployType !== "nixpacks" && project.deployType !== "dockerfile") {
        compose = parseCompose(composeContent);

        // Detect declared volumes from compose YAML before deploy starts
        if (compose.volumes && Object.keys(compose.volumes).length > 0) {
          const existing = (project.persistentVolumes as { name: string; mountPath: string }[] | null) ?? [];
          const existingNames = new Set(existing.map(v => v.name));
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
            const merged = [...existing, ...newVols];
            await db.update(projects).set({ persistentVolumes: merged }).where(eq(projects.id, opts.projectId));
            log(`[deploy] Detected ${newVols.length} compose volume(s): ${newVols.map(v => `${v.name}:${v.mountPath}`).join(", ")}`);
          }
        }
      } else {
        // Build from repo — Nixpacks, Dockerfile, or auto-detect
        const imageName = `host/${project.name}:${deploymentId.slice(0, 8)}`;
        let buildType = project.deployType;

        // Auto-detect: if deploy type is compose but no compose file found, try Dockerfile then Nixpacks
        if (buildType === "compose" && !composeContent) {
          try {
            await readFile(join(root, "Dockerfile"), "utf-8");
            buildType = "dockerfile";
            log(`[deploy] No compose file, found Dockerfile`);
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
        try {
          await buildFromRepo(root, imageName, buildType, logs, envMap);
        } catch (buildErr) {
          const errMsg = buildErr instanceof Error ? buildErr.message : String(buildErr);

          // Detect issues from error output and retry with fixes
          const fixes = detectCompatIssues(errMsg);
          if (fixes.length > 0) {
            log(`[compat] Build failed, detected fixable issues:`);
            for (const fix of fixes) {
              log(`[compat]   ${fix.name}: ${fix.description}`);
            }
            log(`[compat] Retrying with fixes applied...`);
            Object.assign(envMap, applyCompatFixes(envMap, fixes));
            await buildFromRepo(root, imageName, buildType, logs, envMap);
          } else {
            throw buildErr;
          }
        }

        builtLocally = true;
        compose = generateComposeForImage({
          projectName: project.name,
          imageName,
          containerPort: project.containerPort ?? undefined,
          envVars: envMap,
          volumes: (project.persistentVolumes as { name: string; mountPath: string }[] | null) ?? undefined,
          exposedPorts: (project.exposedPorts as { internal: number; external?: number; protocol?: string }[] | null) ?? undefined,
        });
      }
    } else if (project.composeContent) {
      // Direct compose content
      compose = parseCompose(project.composeContent);
      log(`[deploy] Parsed compose content`);

      // Detect declared volumes from compose YAML before deploy starts
      if (compose.volumes && Object.keys(compose.volumes).length > 0) {
        const existing = (project.persistentVolumes as { name: string; mountPath: string }[] | null) ?? [];
        const existingNames = new Set(existing.map(v => v.name));
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
          const merged = [...existing, ...newVols];
          await db.update(projects).set({ persistentVolumes: merged }).where(eq(projects.id, opts.projectId));
          log(`[deploy] Detected ${newVols.length} compose volume(s): ${newVols.map(v => `${v.name}:${v.mountPath}`).join(", ")}`);
        }
      }
    } else {
      throw new Error("No image, git repo, or compose content configured");
    }

    // Step 2: Detect container port
    let detectedPort: number | null = null;

    // Priority: project config > image inspection > PORT env > default
    if (project.containerPort) {
      detectedPort = project.containerPort;
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
    if (!project.containerPort) {
      log(`[deploy] Using port ${containerPort}${detectedPort ? " (auto-detected)" : " (default)"}`);
    }

    // Step 3: Inject Traefik labels + shared network
    for (const domain of project.domains) {
      const port = domain.port || containerPort;
      compose = injectTraefikLabels(compose, {
        projectName: `${project.name}-${domain.id.slice(0, 6)}`,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le",
        ssl: domain.sslEnabled ?? true,
      });
      log(`[deploy] Traefik: ${domain.domain} → :${port}${(domain.sslEnabled ?? true) ? " (TLS)" : ""}`);
    }
    compose = injectNetwork(compose, NETWORK_NAME);

    // Step 3: Add project labels
    for (const [svcName, svc] of Object.entries(compose.services)) {
      compose.services[svcName] = {
        ...svc,
        labels: {
          ...svc.labels,
          "host.project": project.name,
          "host.project.id": project.id,
          "host.deployment.id": deploymentId,
          "host.managed": "true",
        },
      };
    }

    // Step 4: Blue-green slot management
    let activeSlot: "blue" | "green" | null = null;
    try {
      const slotFile = await readFile(join(projectDir, ".active-slot"), "utf-8");
      activeSlot = slotFile.trim() as "blue" | "green";
    } catch { /* no active slot yet */ }

    const newSlot = activeSlot === "blue" ? "green" : "blue";
    const newProjectName = `${project.name}-${newSlot}`;
    const slotDir = join(projectDir, newSlot);
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
      // Load org for resolve context
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, opts.organizationId),
        columns: { id: true, name: true, baseDomain: true },
      });

      // Load org-level shared env vars
      const orgVarRows = await db.query.orgEnvVars.findMany({
        where: eq(orgEnvVars.organizationId, opts.organizationId),
      });
      const orgEnvVarMap: Record<string, string> = {};
      for (const v of orgVarRows) orgEnvVarMap[v.key] = v.value;

      const primaryDomain = project.domains[0]?.domain ?? null;

      const resolveCtx: ResolveContext = {
        project: {
          id: project.id,
          name: project.name,
          displayName: project.displayName,
          containerPort: project.containerPort,
          domain: primaryDomain,
          gitUrl: project.gitUrl,
          gitBranch: project.gitBranch,
          imageName: project.imageName,
        },
        org: {
          id: opts.organizationId,
          name: org?.name ?? "",
          baseDomain: org?.baseDomain ?? null,
        },
        envVars: envMap,
        orgEnvVars: orgEnvVarMap,
        resolveExternalVar: async (projectName: string, varKey: string) => {
          // Find the referenced project in the same org
          const refProject = await db.query.projects.findFirst({
            where: and(
              eq(projects.organizationId, opts.organizationId),
              eq(projects.name, projectName),
            ),
            columns: {
              id: true,
              name: true,
              displayName: true,
              groupId: true,
              containerPort: true,
              gitUrl: true,
              gitBranch: true,
              imageName: true,
            },
            with: { domains: { columns: { domain: true }, limit: 1 } },
          });
          if (!refProject) return null;

          // Check built-in project fields first
          const builtinFields: Record<string, string | null> = {
            name: refProject.name,
            displayName: refProject.displayName,
            port: refProject.containerPort?.toString() ?? null,
            id: refProject.id,
            domain: refProject.domains[0]?.domain ?? null,
            url: refProject.domains[0]?.domain
              ? `https://${refProject.domains[0].domain}`
              : null,
            host: refProject.domains[0]?.domain ?? null,
            internalHost: refProject.name,
            gitUrl: refProject.gitUrl,
            gitBranch: refProject.gitBranch,
            imageName: refProject.imageName,
          };
          if (varKey in builtinFields) return builtinFields[varKey];

          // If the referenced project is in the same group AND we have a
          // groupEnvironmentId, try to resolve from the matching environment
          if (
            opts.groupEnvironmentId &&
            refProject.groupId &&
            project.groupId &&
            refProject.groupId === project.groupId
          ) {
            // Find the environment on the referenced project that belongs
            // to the same group environment
            const refEnv = await db.query.environments.findFirst({
              where: and(
                eq(environments.projectId, refProject.id),
                eq(environments.groupEnvironmentId, opts.groupEnvironmentId),
              ),
              columns: { id: true },
            });

            if (refEnv) {
              // Load base + environment-specific, environment overrides base
              const refBase = await db.query.envVars.findMany({
                where: and(
                  eq(envVars.projectId, refProject.id),
                  isNull(envVars.environmentId),
                ),
              });
              const refMap: Record<string, string> = {};
              for (const v of refBase) refMap[v.key] = v.value;

              const refEnvVars = await db.query.envVars.findMany({
                where: and(
                  eq(envVars.projectId, refProject.id),
                  eq(envVars.environmentId, refEnv.id),
                ),
              });
              for (const v of refEnvVars) refMap[v.key] = v.value;

              if (varKey in refMap) return refMap[varKey];
            }
          }

          // Fall back to the referenced project's base vars (environmentId IS NULL)
          const refVar = await db.query.envVars.findFirst({
            where: and(
              eq(envVars.projectId, refProject.id),
              eq(envVars.key, varKey),
              isNull(envVars.environmentId),
            ),
          });
          return refVar?.value ?? null;
        },
      };

      const resolved = await resolveAllEnvVars(envMap, resolveCtx);
      const envContent = Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join("\n");
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
      const { stdout, stderr } = await execAsync(
        `docker compose -f "${composePath}" -p "${newProjectName}" up -d --pull ${pullPolicy}`,
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
        const { stdout } = await execAsync(
          `docker compose -f "${composePath}" -p "${newProjectName}" logs --tail 30`,
          { cwd: slotDir, timeout: 10000 }
        );
        if (stdout.trim()) {
          for (const line of stdout.trim().split("\n")) {
            log(`[deploy][crash] ${line}`);
          }
        }
      } catch { /* couldn't get logs */ }

      log(`[deploy] Tearing down ${newSlot}`);
      await execAsync(
        `docker compose -f "${composePath}" -p "${newProjectName}" down --remove-orphans`,
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
      const oldSlotDir = join(projectDir, activeSlot);
      const oldProjectName = `${project.name}-${activeSlot}`;
      const oldComposePath = join(oldSlotDir, "docker-compose.yml");
      try {
        await execAsync(
          `docker compose -f "${oldComposePath}" -p "${oldProjectName}" down --remove-orphans`,
          { cwd: oldSlotDir, timeout: 30000 }
        );
        log(`[deploy] Old slot (${activeSlot}) removed`);
      } catch (err) {
        log(`[deploy] Warning: old slot cleanup — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 11: Record active slot
    await writeFile(join(projectDir, ".active-slot"), newSlot, "utf-8");

    stage("cleanup", "success");
    // Step 12: HTTP health check on domains
    for (const domain of project.domains) {
      const ok = await checkEndpoint(domain.domain, logs);
      if (ok) logs.push(`[health] ${domain.domain} responding`);
      else logs.push(`[health] ${domain.domain} not yet reachable (DNS/TLS propagation)`);
    }

    stage("done", "success");
    // Auto-detect persistent volumes from running containers
    try {
      const runningContainers = await listContainers(project.name);
      const detectedVolumes: { name: string; mountPath: string }[] = [];
      const seen = new Set<string>();

      for (const c of runningContainers) {
        const info = await inspectContainer(c.id);
        for (const mount of info.mounts) {
          if (mount.type === "volume" && !seen.has(mount.destination)) {
            seen.add(mount.destination);
            // Extract volume name from source path (last segment)
            const parts = mount.source.split("/");
            const rawName = parts[parts.length - 1];
            // Strip compose project prefix (e.g. "redis-green_data" → "data")
            const name = rawName.replace(/^[^_]*_/, "");
            detectedVolumes.push({ name, mountPath: mount.destination });
          }
        }
      }

      if (detectedVolumes.length > 0) {
        const existing = (project.persistentVolumes as { name: string; mountPath: string }[] | null) ?? [];
        const existingPaths = new Set(existing.map((v) => v.mountPath));
        const newVolumes = detectedVolumes.filter((v) => !existingPaths.has(v.mountPath));

        if (newVolumes.length > 0) {
          const merged = [...existing, ...newVolumes];
          await db
            .update(projects)
            .set({ persistentVolumes: merged })
            .where(eq(projects.id, opts.projectId));
          log(`[deploy] Detected ${newVolumes.length} volume(s): ${newVolumes.map((v) => v.mountPath).join(", ")}`);
        }
      }
    } catch {
      // Volume detection is best-effort
    }

    // Mark project as active
    await db
      .update(projects)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    const durationMs = Date.now() - startTime;
    await db
      .update(deployments)
      .set({ status: "success", log: logLines.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    // Publish event for real-time UI updates
    publishEvent(projectChannel(opts.projectId), {
      event: "deploy:complete",
      status: "active",
      deploymentId,
      success: true,
      durationMs,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.succeeded",
      projectId: opts.projectId,
      metadata: { deploymentId, durationMs },
    }).catch(() => {});

    // Send success notification (non-blocking)
    sendDeployNotification(project, deploymentId, true, durationMs).catch(() => {});

    return { deploymentId, success: true, log: logLines.join("\n"), durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log(`[deploy] ERROR: ${message}`);
    const durationMs = Date.now() - startTime;

    await db
      .update(deployments)
      .set({ status: "failed", log: logLines.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    await db
      .update(projects)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    // Publish event for real-time UI updates
    publishEvent(projectChannel(opts.projectId), {
      event: "deploy:complete",
      status: "error",
      deploymentId,
      success: false,
      durationMs,
    }).catch(() => {});

    recordActivity({
      organizationId: opts.organizationId,
      action: "deployment.failed",
      projectId: opts.projectId,
      metadata: { deploymentId, error: message },
    }).catch(() => {});

    // Send failure notification (non-blocking) — project may not be fetched yet
    sendDeployNotification(
      { id: opts.projectId, name: "", displayName: "", domains: [] },
      deploymentId, false, durationMs, message
    ).catch(() => {});

    return { deploymentId, success: false, log: logLines.join("\n"), durationMs };
  }
}

async function sendDeployNotification(
  project: { id: string; name: string; displayName: string; domains: { domain: string }[] },
  deploymentId: string,
  success: boolean,
  durationMs: number,
  errorMessage?: string,
) {
  try {
    const { sendEmail } = await import("@/lib/email/send");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const dashboardUrl = `${appUrl}/projects/${project.id}`;
    const domain = project.domains[0]?.domain;

    // TODO: send to project notification recipients (for now, skip if no MAILPACE_API_TOKEN)
    if (!process.env.MAILPACE_API_TOKEN) return;

    // Fetch deployment for git info
    const deployment = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: { gitSha: true, gitMessage: true, triggeredBy: true },
    });

    // Fetch triggered by user name
    let triggeredByName: string | undefined;
    if (deployment?.triggeredBy) {
      const { user: userTable } = await import("@/lib/db/schema");
      const u = await db.query.user.findFirst({
        where: eq(userTable.id, deployment.triggeredBy),
        columns: { name: true, email: true },
      });
      triggeredByName = u?.name || u?.email || undefined;
    }

    if (success) {
      const { DeploySuccessEmail } = await import("@/lib/email/templates/deploy-success");
      const duration = durationMs < 1000 ? `${durationMs}ms` : `${Math.round(durationMs / 1000)}s`;
      // TODO: send to configured recipients
      console.log(`[email] Would send deploy success notification for ${project.displayName}`);
    } else {
      const { DeployFailedEmail } = await import("@/lib/email/templates/deploy-failed");
      console.log(`[email] Would send deploy failure notification for ${project.displayName}`);
    }
  } catch (err) {
    console.error("[email] Notification error:", err);
  }
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
  envVars?: Record<string, string>
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

    await spawnStream("nixpacks", args, { cwd: repoPath, env: buildEnv }, logs, "[build][nixpacks]");
    logs.push(`[build] Nixpacks build complete: ${imageName}`);
    return;
  }

  logs.push(`[build] Building with Dockerfile...`);

  const args = ["build", "-t", imageName];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      args.push("--build-arg", `${k}=${v}`);
    }
  }
  args.push(repoPath);

  await spawnStream("docker", args, { cwd: repoPath }, logs, "[build][docker]");
  logs.push(`[build] Docker build complete: ${imageName}`);
}

function spawnStream(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  logs: { push: (line: string) => void },
  prefix: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";

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
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderrBuf.slice(-500)}`));
    });

    proc.on("error", (err) => reject(err));

    // 5 minute timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error(`${cmd} timed out after 300s`));
    }, 300000);
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
      const { stdout } = await execAsync(
        `docker compose -f "${composePath}" -p "${projectName}" ps --format json`,
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

export async function stopProject(
  projectId: string,
  projectName: string
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    const projectDir = join(PROJECTS_DIR, projectName);

    // Read active slot
    let activeSlot: string;
    try {
      activeSlot = (await readFile(join(projectDir, ".active-slot"), "utf-8")).trim();
    } catch {
      activeSlot = "blue";
    }

    const slotDir = join(projectDir, activeSlot);
    const composePath = join(slotDir, "docker-compose.yml");
    const composeProject = `${projectName}-${activeSlot}`;

    const { stdout, stderr } = await execAsync(
      `docker compose -f "${composePath}" -p "${composeProject}" down`,
      { cwd: slotDir, timeout: 60000 }
    );
    if (stdout.trim()) logs.push(stdout.trim());
    if (stderr.trim()) logs.push(stderr.trim());

    await db
      .update(projects)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return { success: true, log: logs.join("\n") };
  } catch (err) {
    logs.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, log: logs.join("\n") };
  }
}

export async function restartProject(
  projectId: string,
  projectName: string
): Promise<{ success: boolean; log: string }> {
  const logs: string[] = [];
  try {
    const projectDir = join(PROJECTS_DIR, projectName);

    let activeSlot: string;
    try {
      activeSlot = (await readFile(join(projectDir, ".active-slot"), "utf-8")).trim();
    } catch {
      activeSlot = "blue";
    }

    const slotDir = join(projectDir, activeSlot);
    const composePath = join(slotDir, "docker-compose.yml");
    const composeProject = `${projectName}-${activeSlot}`;

    const { stdout, stderr } = await execAsync(
      `docker compose -f "${composePath}" -p "${composeProject}" restart`,
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
