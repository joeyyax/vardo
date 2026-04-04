// ---------------------------------------------------------------------------
// Deploy Steps 4-5: Blue-green slot management, compose file writing,
// volume externalization, and .env resolution.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { orgEnvVars, apps, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, rm, readlink, symlink, copyFile, lstat, stat, readdir } from "fs/promises";
import { join } from "path";
import { PROJECTS_DIR } from "@/lib/paths";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { resolveAllEnvVars, type ResolveContext } from "@/lib/env/resolve";
import {
  isAnonymousVolume,
  composeToYaml,
  buildVardoOverlay,
} from "../compose";
import {
  APP_UID,
  NETWORK_NAME as VARDO_NETWORK,
  VOLUME_CREATE_TIMEOUT,
  DOCKER_CHOWN_TIMEOUT,
} from "../constants";
import type { DeployContext } from "../deploy-context";

const execFileAsync = promisify(execFile);
const NETWORK_NAME = VARDO_NETWORK;

/**
 * Create a directory and ensure the app user (1001) can write to it.
 */
async function ensureWritableDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    const probe = join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EACCES") {
      if (!dir.startsWith(PROJECTS_DIR + "/")) {
        throw new Error(`Permission denied and path outside apps dir: ${dir}`);
      }
      await execFileAsync("docker", [
        "run", "--rm", "-v", `${dir}:/target`, "alpine", "chown", "-R", `${APP_UID}:${APP_UID}`, "/target",
      ], { timeout: DOCKER_CHOWN_TIMEOUT });
    } else {
      throw err;
    }
  }
}

export async function build(ctx: DeployContext): Promise<DeployContext> {
  const { app, log, envMap, compose } = ctx;
  const appDir = ctx.appDir;
  const repoDir = ctx.repoDir;

  // Step 4: Blue-green slot management (skipped for local environments)
  const isLocalEnv = ctx.envType === "local";
  ctx.isLocalEnv = isLocalEnv;
  let activeSlot: "blue" | "green" | null = null;
  let newSlot: string;

  if (isLocalEnv) {
    newSlot = "local";
    ctx.newProjectName = `${app.name}-${ctx.envName}`;
    ctx.slotDir = join(appDir, "local");
  } else {
    try {
      activeSlot = (await readlink(join(appDir, "current"))).trim() as "blue" | "green";
    } catch { /* no active slot yet */ }

    newSlot = activeSlot === "blue" ? "green" : "blue";
    ctx.newProjectName = `${app.name}-${ctx.envName}-${newSlot}`;
    ctx.slotDir = join(appDir, newSlot);
  }
  ctx.activeSlot = activeSlot;
  ctx.newSlot = newSlot;
  const slotDir = ctx.slotDir;
  const newProjectName = ctx.newProjectName;

  await ensureWritableDir(slotDir);

  ctx.checkAbort();
  ctx.stage("build", "success");
  ctx.stage("deploy", "running");
  log(`[deploy] Active slot: ${activeSlot || "none"}, deploying to: ${newSlot}`);

  // Step 5: Write compose file
  // Link repo contents into the slot dir for build contexts and relative mounts
  if (repoDir) {
    const entries = await readdir(repoDir);
    for (const entry of entries) {
      if (entry === "docker-compose.yml" || entry === "docker-compose.yaml" || entry === "compose.yml" || entry === "compose.yaml" || entry === ".env") continue;
      const source = join(repoDir, entry);
      const target = join(slotDir, entry);
      try {
        const st = await lstat(target);
        if (st.isSymbolicLink()) {
          await rm(target);
        }
      } catch { /* doesn't exist — fine */ }
      try {
        await lstat(target);
      } catch {
        const st = await stat(source);
        if (st.isDirectory()) {
          await symlink(source, target);
        } else {
          await copyFile(source, target);
        }
      }
    }

    // Remove stale entries in the slot dir that no longer exist in the repo
    const repoEntrySet = new Set(entries);
    const MANAGED_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.override.yml", ".env"]);
    try {
      const slotEntries = await readdir(slotDir);
      for (const entry of slotEntries) {
        if (MANAGED_FILES.has(entry)) continue;
        if (repoEntrySet.has(entry)) continue;
        try {
          await rm(join(slotDir, entry), { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    } catch { /* slot dir may not exist yet */ }
  }

  // Step 5a: Externalize named volumes
  const stableVolumePrefix = `${app.name}-${ctx.envName}`;
  ctx.stableVolumePrefix = stableVolumePrefix;
  if (compose.volumes && Object.keys(compose.volumes).length > 0) {
    const externalized: string[] = [];

    for (const volName of Object.keys(compose.volumes)) {
      if (isAnonymousVolume(volName)) continue;
      const stableName = `${stableVolumePrefix}_${volName}`;

      try {
        await execFileAsync("docker", ["volume", "create", stableName], { timeout: VOLUME_CREATE_TIMEOUT });
      } catch { /* already exists — fine */ }

      compose.volumes[volName] = { external: true, name: stableName };
      externalized.push(`${volName} → ${stableName}`);
    }

    if (externalized.length > 0) {
      log(`[deploy] Externalized ${externalized.length} volume(s): ${externalized.join(", ")}`);
    }
  }

  // Step 5b: Write the two physical compose files
  const bareComposePath = join(slotDir, "docker-compose.yml");
  const overridePath = join(slotDir, "docker-compose.override.yml");

  for (const stale of [bareComposePath, overridePath, join(slotDir, ".env")]) {
    try { await rm(stale, { force: true }); } catch { /* gone already */ }
  }

  const overlayCompose = buildVardoOverlay({
    fullCompose: compose,
    networkName: NETWORK_NAME,
    cpuLimit: app.cpuLimit,
    memoryLimit: app.memoryLimit,
    gpuEnabled: app.gpuEnabled ?? false,
    externalVolumes: compose.volumes ?? {},
    bareVolumeNames: Object.keys(ctx.bareCompose.volumes ?? {}),
  });

  await writeFile(bareComposePath, composeToYaml(ctx.bareCompose), "utf-8");
  await writeFile(overridePath, composeToYaml(overlayCompose), "utf-8");

  const composeFileArgs = ["-f", bareComposePath, "-f", overridePath];
  ctx.composeFileArgs = composeFileArgs;

  // Write .env — resolve template expressions using the full resolution engine
  if (Object.keys(envMap).length > 0) {
    const orgVarRows = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, ctx.organizationId),
    });
    const orgEnvVarMap: Record<string, string> = {};
    for (const v of orgVarRows) {
      if (v.isSecret) {
        const { content, decryptFailed } = decryptOrFallback(v.value, ctx.organizationId);
        if (decryptFailed) {
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
        id: ctx.organizationId,
        name: ctx.org?.name ?? "",
        baseDomain: ctx.org?.baseDomain ?? null,
      },
      envVars: envMap,
      orgEnvVars: orgEnvVarMap,
      resolveExternalVar: async (appName: string, varKey: string) => {
        const refApp = await db.query.apps.findFirst({
          where: and(
            eq(apps.organizationId, ctx.organizationId),
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

        if (
          ctx.groupEnvironmentId &&
          refApp.projectId &&
          app.projectId &&
          refApp.projectId === app.projectId
        ) {
          const refEnv = await db.query.environments.findFirst({
            where: and(
              eq(environments.appId, refApp.id),
              eq(environments.groupEnvironmentId, ctx.groupEnvironmentId),
            ),
            columns: { id: true },
          });

          if (refEnv) {
            // Environment-specific resolution would go here
          }
        }

        if (!refApp.envContent) return null;
        const { content: refText } = decryptOrFallback(refApp.envContent, refApp.organizationId);
        if (!refText) return null;
        const refMap = parseEnvToMap(refText);
        return refMap[varKey] ?? null;
      },
    };

    const resolved = await resolveAllEnvVars(envMap, resolveCtx);
    const envContent = Object.entries(resolved).map(([k, v]) => {
      if (/[\n\r"' $#\\]/.test(v)) {
        return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
      }
      return `${k}=${v}`;
    }).join("\n");
    await writeFile(join(slotDir, ".env"), envContent, "utf-8");
  }

  return ctx;
}
