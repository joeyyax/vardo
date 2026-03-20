import { db } from "@/lib/db";
import { deployments, projects, envVars } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { exec } from "child_process";
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
import { ensureNetwork } from "./client";
import { getInstallationToken } from "@/lib/github/app";
import { githubAppInstallations, memberships } from "@/lib/db/schema";

const execAsync = promisify(exec);

const PROJECTS_DIR = resolve(process.env.HOST_PROJECTS_DIR || "./.host/projects");
const NETWORK_NAME = "host-network";
const HEALTH_CHECK_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 2000;

type DeployOpts = {
  projectId: string;
  organizationId: string;
  trigger: "manual" | "webhook" | "api" | "rollback";
  triggeredBy?: string;
  environmentId?: string;
};

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
    })
    .returning({ id: deployments.id });

  return deployment.id;
}

export async function runDeployment(
  deploymentId: string,
  opts: DeployOpts
): Promise<DeployResult> {
  const startTime = Date.now();
  const logs: string[] = [];

  try {
    await db
      .update(deployments)
      .set({ status: "running" })
      .where(eq(deployments.id, deploymentId));

    logs.push(`[deploy] Starting deployment ${deploymentId}`);

    // Fetch project
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, opts.projectId),
        eq(projects.organizationId, opts.organizationId)
      ),
      with: { domains: true },
    });

    if (!project) throw new Error("Project not found");

    logs.push(`[deploy] Project: ${project.displayName} (${project.name})`);
    logs.push(`[deploy] Source: ${project.source}, Type: ${project.deployType}`);

    // Fetch env vars
    const projectEnvVars = await db.query.envVars.findMany({
      where: eq(envVars.projectId, opts.projectId),
    });
    const envMap: Record<string, string> = {};
    for (const v of projectEnvVars) envMap[v.key] = v.value;

    logs.push(`[deploy] ${projectEnvVars.length} env var(s), ${project.domains.length} domain(s)`);

    // Step 1: Generate or fetch compose file
    let compose: ComposeFile;
    const projectDir = join(PROJECTS_DIR, project.name);
    await mkdir(projectDir, { recursive: true });

    if (project.deployType === "image" && project.imageName) {
      // Image deploy — generate a compose file
      compose = generateComposeForImage({
        projectName: project.name,
        imageName: project.imageName,
        containerPort: project.containerPort ?? undefined,
        envVars: envMap,
      });
      logs.push(`[deploy] Generated compose for image: ${project.imageName}`);
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
                logs.push(`[deploy] Got GitHub token via ${inst.accountLogin}`);
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
          logs.push(`[deploy] Warning: GitHub auth — ${err instanceof Error ? err.message : err}`);
        }
      }

      try {
        // Try pull first (faster if already cloned)
        await execAsync(
          `git -C "${repoDir}" remote set-url origin "${cloneUrl}" && git -C "${repoDir}" fetch origin ${branch} && git -C "${repoDir}" reset --hard origin/${branch}`,
          { timeout: 60000 }
        );
        logs.push(`[deploy] Pulled latest from ${branch}`);
      } catch {
        // Fresh clone
        await execAsync(`git clone --depth 1 --branch ${branch} "${cloneUrl}" "${repoDir}"`, { timeout: 60000 });
        logs.push(`[deploy] Cloned repo (${branch})`);
      }

      // Find compose file
      const root = project.rootDirectory ? join(repoDir, project.rootDirectory) : repoDir;
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
          logs.push(`[deploy] Found ${candidate}`);
          break;
        } catch { /* try next */ }
      }

      if (!composeContent) {
        throw new Error(`No compose file found in repo (tried: ${composeCandidates.join(", ")})`);
      }

      compose = parseCompose(composeContent);
    } else if (project.composeContent) {
      // Direct compose content
      compose = parseCompose(project.composeContent);
      logs.push(`[deploy] Parsed compose content`);
    } else {
      throw new Error("No image, git repo, or compose content configured");
    }

    // Step 2: Inject shared network (no Traefik labels yet — blue-green)
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

    logs.push(`[deploy] Active slot: ${activeSlot || "none"}, deploying to: ${newSlot}`);

    // Step 5: Write compose file (without Traefik labels — new container starts but doesn't receive traffic)
    const composePath = join(slotDir, "docker-compose.yml");
    await writeFile(composePath, composeToYaml(compose), "utf-8");

    // Write .env
    if (Object.keys(envMap).length > 0) {
      const envContent = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n");
      await writeFile(join(slotDir, ".env"), envContent, "utf-8");
    }

    // Step 6: Ensure network
    try {
      await ensureNetwork(NETWORK_NAME);
    } catch (err) {
      logs.push(`[deploy] Warning: network — ${err instanceof Error ? err.message : err}`);
    }

    // Step 7: Pull and start new slot (no traffic yet)
    logs.push(`[deploy] Starting ${newSlot} slot...`);
    try {
      const { stdout, stderr } = await execAsync(
        `docker compose -f "${composePath}" -p "${newProjectName}" up -d --pull always`,
        { cwd: slotDir, timeout: 120000 }
      );
      if (stdout.trim()) logs.push(`[docker] ${stdout.trim()}`);
      if (stderr.trim()) logs.push(`[docker] ${stderr.trim()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`docker compose up (${newSlot}) failed: ${message}`);
    }

    // Step 8: Health check — wait for new slot to be ready
    logs.push(`[deploy] Waiting for ${newSlot} to be healthy...`);
    const healthy = await waitForHealthy(newProjectName, composePath, slotDir, logs);
    if (!healthy) {
      // Roll back: tear down the failed new slot
      logs.push(`[deploy] Health check failed, tearing down ${newSlot}`);
      await execAsync(
        `docker compose -f "${composePath}" -p "${newProjectName}" down --remove-orphans`,
        { cwd: slotDir, timeout: 30000 }
      ).catch(() => {});
      throw new Error(`${newSlot} slot did not become healthy within timeout`);
    }
    logs.push(`[deploy] ${newSlot} healthy`);

    // Step 9: Swap traffic — inject Traefik labels into the new slot's compose and redeploy
    let composeWithTraefik = compose;
    for (const domain of project.domains) {
      const port = domain.port || project.containerPort || 80;
      composeWithTraefik = injectTraefikLabels(composeWithTraefik, {
        projectName: `${project.name}-${domain.id.slice(0, 6)}`,
        domain: domain.domain,
        containerPort: port,
        certResolver: domain.certResolver || "le",
      });
    }
    // Re-inject network since injectTraefikLabels returns a new object
    composeWithTraefik = injectNetwork(composeWithTraefik, NETWORK_NAME);

    // Reapply labels
    for (const [svcName, svc] of Object.entries(composeWithTraefik.services)) {
      composeWithTraefik.services[svcName] = {
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

    await writeFile(composePath, composeToYaml(composeWithTraefik), "utf-8");

    // Redeploy with Traefik labels — Traefik picks up the new labels, traffic starts flowing
    try {
      await execAsync(
        `docker compose -f "${composePath}" -p "${newProjectName}" up -d --no-recreate`,
        { cwd: slotDir, timeout: 30000 }
      );
      logs.push(`[deploy] Traffic routed to ${newSlot}`);
    } catch (err) {
      logs.push(`[deploy] Warning: label update — ${err instanceof Error ? err.message : err}`);
    }

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
        logs.push(`[deploy] Old slot (${activeSlot}) removed`);
      } catch (err) {
        logs.push(`[deploy] Warning: old slot cleanup — ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 11: Record active slot
    await writeFile(join(projectDir, ".active-slot"), newSlot, "utf-8");

    // Step 12: HTTP health check on domains
    for (const domain of project.domains) {
      const ok = await checkEndpoint(domain.domain, logs);
      if (ok) logs.push(`[health] ${domain.domain} responding`);
      else logs.push(`[health] ${domain.domain} not yet reachable (DNS/TLS propagation)`);
    }

    // Mark project as active
    await db
      .update(projects)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    const durationMs = Date.now() - startTime;
    await db
      .update(deployments)
      .set({ status: "success", log: logs.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    return { deploymentId, success: true, log: logs.join("\n"), durationMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logs.push(`[deploy] ERROR: ${message}`);
    const durationMs = Date.now() - startTime;

    await db
      .update(deployments)
      .set({ status: "failed", log: logs.join("\n"), durationMs, finishedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    await db
      .update(projects)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(projects.id, opts.projectId));

    return { deploymentId, success: false, log: logs.join("\n"), durationMs };
  }
}

export async function deployProject(opts: DeployOpts): Promise<DeployResult> {
  const deploymentId = await createDeployment(opts);
  return runDeployment(deploymentId, opts);
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

async function waitForHealthy(
  projectName: string,
  composePath: string,
  cwd: string,
  logs: string[]
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

async function checkEndpoint(domain: string, logs: string[]): Promise<boolean> {
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
