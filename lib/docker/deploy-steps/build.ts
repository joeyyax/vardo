// ---------------------------------------------------------------------------
// Deploy Steps 4-5: Blue-green slot management, compose file writing,
// volume externalization, and .env resolution.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { orgEnvVars, apps, environments } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, rm, symlink, copyFile, stat, readdir } from "fs/promises";
import { join } from "path";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { resolveAllEnvVars, type ResolveContext } from "@/lib/env/resolve";
import {
  isAnonymousVolume,
  composeToYaml,
  buildVardoOverlay,
  defaultMemoryLimitMb,
} from "../compose";
import {
  NETWORK_NAME as VARDO_NETWORK,
  VOLUME_CREATE_TIMEOUT,
  ensureWritableDir,
} from "../constants";
import type { DeployContext } from "../deploy-context";
import { detectActiveSlot } from "../slots";
import { crossBoundaryVolumeName, volumesByOwner } from "../shared-volumes";
import { isSelfApp, seedSelfEnv } from "../self-env";
import { resolveServiceDSNs, DSN_ENV_KEY } from "@/lib/error-tracking/inject";
import {
  DEFAULT_NETWORK,
  networkCreateArgs,
  sharedNetworkName,
  sharedNetworks,
} from "../shared-networks";

const execFileAsync = promisify(execFile);
const NETWORK_NAME = VARDO_NETWORK;

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
    // Resolve the active slot from the symlink, then Docker ground-truth, then
    // the legacy file. Detecting a still-running old slot is what lets the swap
    // step tear it down before starting the new slot — without this, a stale
    // slot holding a host port causes "port already allocated".
    activeSlot = await detectActiveSlot(appDir, `${app.name}-${ctx.envName}`);

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
  log(`[deploy] Active slot: ${activeSlot || "none"}, deploying to: ${newSlot}`);

  // Step 5: Write compose file
  // Link repo contents into the slot dir for build contexts and relative mounts.
  // Directories are symlinked to repoDir (auto-fresh on every git reset).
  // Regular files are copied — and on every deploy we replace the slot's copy
  // from repoDir, otherwise stale files (e.g. a Dockerfile from the first
  // deploy) would shadow the freshly-pulled commit.
  if (repoDir) {
    const entries = await readdir(repoDir);
    for (const entry of entries) {
      if (entry === "docker-compose.yml" || entry === "docker-compose.yaml" || entry === "compose.yml" || entry === "compose.yaml" || entry === ".env") continue;
      const source = join(repoDir, entry);
      const target = join(slotDir, entry);
      const sourceSt = await stat(source);

      try {
        await rm(target, { recursive: true, force: true });
      } catch { /* nothing to remove */ }

      if (sourceSt.isDirectory()) {
        await symlink(source, target);
      } else {
        await copyFile(source, target);
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
    // Volumes belonging only to non-rotating services keep compose-native
    // naming, so a pinned shared project still finds the data it created.
    const { sharedOnly, crossBoundary } = volumesByOwner(compose);

    for (const volName of Object.keys(compose.volumes)) {
      if (isAnonymousVolume(volName)) continue;
      if (sharedOnly.has(volName)) continue;
      const stableName = crossBoundary.has(volName)
        ? crossBoundaryVolumeName(compose, volName, stableVolumePrefix)
        : `${stableVolumePrefix}_${volName}`;

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

  // Step 5a2: Externalize networks a shared service attaches to, so the shared
  // and slot projects join one network instead of each declaring their own.
  const sharedNets = sharedNetworks(compose);
  if (sharedNets.size > 0) {
    compose.networks ??= {};
    ctx.bareCompose.networks ??= {};
    for (const netName of sharedNets) {
      const externalName = sharedNetworkName(compose, netName, stableVolumePrefix);
      try {
        await execFileAsync(
          "docker",
          networkCreateArgs(compose.networks[netName], externalName),
          { timeout: VOLUME_CREATE_TIMEOUT },
        );
      } catch { /* already exists — fine */ }
      const external = { external: true, name: externalName };
      compose.networks[netName] = external;
      // The bare file is written separately and would otherwise still declare
      // the network, so compose creates a second one and a pinned subnet clashes.
      // Key presence, not truthiness: `internal:` with no config parses to null.
      // The implicit default is never a key, and is the one both projects need.
      if (netName === DEFAULT_NETWORK || netName in ctx.bareCompose.networks) {
        ctx.bareCompose.networks[netName] = external;
      }
    }
    log(`[deploy] Shared network(s): ${[...sharedNets].join(", ")}`);
  }

  // Step 5b: Write the two physical compose files
  const bareComposePath = join(slotDir, "docker-compose.yml");
  const overridePath = join(slotDir, "docker-compose.override.yml");

  for (const stale of [bareComposePath, overridePath, join(slotDir, ".env")]) {
    try { await rm(stale, { force: true }); } catch { /* gone already */ }
  }

  // Rewrite every service's build context to the absolute repoDir build
  // root. The slot dir is full of symlinks pointing OUT to repoDir, and
  // BuildKit refuses to traverse symlinks that escape the build context —
  // so a `context: .` resolved relative to slotDir would yield an empty
  // build with all source dirs missing. Pointing the context at repoDir
  // directly sidesteps the symlink trap entirely.
  if (repoDir) {
    const buildRoot = app.rootDirectory
      ? join(repoDir, app.rootDirectory)
      : ctx.hostConfig?.project?.rootDirectory
      ? join(repoDir, ctx.hostConfig.project.rootDirectory)
      : repoDir;

    const rewriteBuildContext = (composeFile: typeof compose) => {
      for (const service of Object.values(composeFile.services)) {
        if (!service.build) continue;
        if (typeof service.build === "string") {
          // Shorthand `build: ./path` → resolve relative to buildRoot
          const ctxPath = service.build === "." || service.build === ""
            ? buildRoot
            : join(buildRoot, service.build);
          service.build = { context: ctxPath };
        } else {
          const ctxPath = service.build.context === "." || service.build.context === ""
            ? buildRoot
            : service.build.context.startsWith("/")
            ? service.build.context
            : join(buildRoot, service.build.context);
          service.build.context = ctxPath;
        }
      }
    };
    rewriteBuildContext(compose);
    rewriteBuildContext(ctx.bareCompose);
  }

  // Fetch exposed ports + per-service env vars from child app records.
  const serviceExposedPorts: Record<string, { internal: number; external?: number; protocol?: string }[]> = {};
  // Raw (decrypted, parsed, not yet template-resolved) env per service from
  // decomposed child apps. Resolved during env resolution and folded into the
  // overlay below. Empty for non-decomposed apps → no behavior change.
  const serviceEnvRaw: Record<string, Record<string, string>> = {};
  // Compose service → child app name, so error tracking can key a project per child.
  const serviceAppNames: Record<string, string> = {};
  if (Object.keys(compose.services).length > 1) {
    const childApps = await db.query.apps.findMany({
      where: and(
        eq(apps.parentAppId, app.id),
        eq(apps.organizationId, ctx.organizationId),
      ),
      columns: { composeService: true, exposedPorts: true, envContent: true, name: true },
    });
    for (const child of childApps) {
      if (!child.composeService) continue;
      serviceAppNames[child.composeService] = child.name;
      if (child.exposedPorts) {
        const ports = child.exposedPorts as { internal: number; external?: number; protocol?: string }[];
        if (ports.length > 0) {
          serviceExposedPorts[child.composeService] = ports;
        }
      }
      if (child.envContent) {
        const { content } = decryptOrFallback(child.envContent, ctx.organizationId);
        if (content) {
          const map = parseEnvToMap(content);
          if (Object.keys(map).length > 0) serviceEnvRaw[child.composeService] = map;
        }
      }
    }
  }
  // Also check the parent app's own exposedPorts (for single-service or the primary service)
  if (app.exposedPorts) {
    const parentPorts = app.exposedPorts as { internal: number; external?: number; protocol?: string }[];
    if (parentPorts.length > 0) {
      const primaryService = Object.keys(compose.services)[0];
      if (primaryService && !serviceExposedPorts[primaryService]) {
        serviceExposedPorts[primaryService] = parentPorts;
      }
    }
  }

  if (!app.memoryLimit) {
    if (app.priority === "critical") {
      throw new Error(
        `[deploy] critical-priority app requires a memory limit — set one before deploying`,
      );
    }
    const tier = app.priority ?? "standard";
    ctx.log(
      `[deploy] No memory limit set — applying the ${tier} tier default of ${defaultMemoryLimitMb(tier)}MB`,
    );
  }

  // Per-service env (decomposed children) can reference templates/secrets, so it
  // is resolved during env resolution below, then folded into the overlay. The
  // overlay itself is built after that so resolved values are available.
  const resolvedServiceEnv: Record<string, Record<string, string>> = {};

  // Write .env — resolve template expressions using the full resolution engine.
  // Runs when the parent has env vars OR any child service does (the resolution
  // context is shared between both).
  if (Object.keys(envMap).length > 0 || Object.keys(serviceEnvRaw).length > 0) {
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

    if (Object.keys(envMap).length > 0) {
      const resolved = await resolveAllEnvVars(envMap, resolveCtx);
      const envContent = Object.entries(resolved).map(([k, v]) => {
        if (/[\n\r"' $#\\]/.test(v)) {
          return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
        }
        return `${k}=${v}`;
      }).join("\n");
      await writeFile(join(slotDir, ".env"), envContent, "utf-8");
    }

    // Resolve each decomposed child service's env through the same engine so its
    // values can reference templates/secrets/org vars, then inject per-service.
    for (const [service, raw] of Object.entries(serviceEnvRaw)) {
      resolvedServiceEnv[service] = await resolveAllEnvVars(raw, resolveCtx);
    }
  }

  // Vardo's own secrets live on the host, not in its database, so the write
  // above is skipped and compose would silently fall back to its defaults.
  const seededEnv = await seedSelfEnv(app.name, appDir, slotDir, activeSlot);
  if (seededEnv) {
    log(`[deploy] Seeded slot .env from ${seededEnv}`);
  } else if (isSelfApp(app.name)) {
    log(`[deploy] Warning: no .env found to seed — compose defaults would apply`);
  }

  // Error tracking: one GlitchTip project per app row, so a decomposed child's
  // errors land where its own Errors tab looks for them. Operator-set DSNs win,
  // and GlitchTip being absent or down just means no DSN.
  const injectedDSNs = await resolveServiceDSNs({
    appName: app.name,
    services: compose.services,
    serviceAppNames,
    appEnv: envMap,
    serviceEnv: serviceEnvRaw,
  });
  const dsnServices = Object.keys(injectedDSNs);
  if (dsnServices.length > 0) {
    for (const service of dsnServices) {
      resolvedServiceEnv[service] = { ...resolvedServiceEnv[service], [DSN_ENV_KEY]: injectedDSNs[service] };
    }
    log(`[deploy] Error tracking: ${DSN_ENV_KEY} set for ${dsnServices.length} service(s)`);
  }

  const overlayCompose = buildVardoOverlay({
    fullCompose: compose,
    networkName: NETWORK_NAME,
    cpuLimit: app.cpuLimit,
    memoryLimit: app.memoryLimit,
    priority: app.priority,
    gpuEnabled: app.gpuEnabled ?? false,
    externalVolumes: compose.volumes ?? {},
    bareVolumeNames: Object.keys(ctx.bareCompose.volumes ?? {}),
    serviceExposedPorts,
    serviceConfig: ctx.serviceConfig,
    serviceEnv: resolvedServiceEnv,
  });

  await writeFile(bareComposePath, composeToYaml(ctx.bareCompose), "utf-8");
  await writeFile(overridePath, composeToYaml(overlayCompose), "utf-8");

  ctx.composeFileArgs = ["-f", bareComposePath, "-f", overridePath];

  // The repo-build path already closed compose and opened build in prepare-repo.
  if (!ctx.builtLocally) {
    ctx.stage("compose", "success");
    ctx.stage("build", "running");
  }

  return ctx;
}
