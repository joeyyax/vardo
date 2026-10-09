// Deploy steps 4-5: slot selection, compose files, volume externalization and .env.

import { detectHost } from "@/lib/resources/host";
import { db } from "@/lib/db";
import { orgEnvVars, apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { mkdir, writeFile, rm, symlink, copyFile, stat, lstat, readdir, chmod } from "fs/promises";
import { dirname, join } from "path";
import { decryptOrFallback } from "@/lib/crypto/encrypt";
import { DeployBlockedError } from "../errors";
import { parseEnvToMap } from "@/lib/env/parse-env";
import { composeEnvFile } from "@/lib/env/compose-env-file";
import { resolveAllEnvVars, type ResolveContext } from "@/lib/env/resolve";
import { externalVarResolver } from "./external-var";
import { environmentEnvContent } from "../environment-env";
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
import { nonRotatingServices } from "../slot-partition";
import { anchorSharedPaths, sharedPathsDir } from "../shared-paths";
import {
  DEFAULT_NETWORK,
  networkCreateArgs,
  sharedNetworkName,
  sharedNetworks,
} from "../shared-networks";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { assertComposeWithinApp } from "../compose-policy";
import { volumePrefix } from "../volume-prefix";
import { appRootDir } from "../compose-root";
import { CERTS_VOLUME_KEY, syncAppCerts } from "@/lib/ssl/cert-export";

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
    // A stale running slot must be detected so swap can stop it; otherwise host ports collide.
    activeSlot = await detectActiveSlot(appDir, `${app.name}-${ctx.envName}`);

    newSlot = activeSlot === "blue" ? "green" : "blue";
    ctx.newProjectName = `${app.name}-${ctx.envName}-${newSlot}`;
    ctx.slotDir = join(appDir, newSlot);
  }
  ctx.activeSlot = activeSlot;
  ctx.newSlot = newSlot;
  const slotDir = ctx.slotDir;

  await ensureWritableDir(slotDir);

  ctx.checkAbort();
  log(`[deploy] Active slot: ${activeSlot || "none"}, deploying to: ${newSlot}`);

  // Step 5: link repo contents into the slot. Directories are symlinked; files are recopied every deploy.
  if (repoDir) {
    const entries = await readdir(repoDir);
    for (const entry of entries) {
      if (!isLinkedRepoEntry(entry)) continue;
      const source = join(repoDir, entry);
      const target = join(slotDir, entry);
      const sourceSt = await stat(source);
      // Copying would read a symlink's target into the slot; a link keeps it visible to the policy check.
      const linkOnly = !ctx.orgTrusted && (await lstat(source)).isSymbolicLink();

      try {
        await rm(target, { recursive: true, force: true });
      } catch { /* nothing to remove */ }

      if (sourceSt.isDirectory() || linkOnly) {
        await symlink(source, target);
      } else {
        await copyFile(source, target);
      }
    }

    // Remove slot entries no longer in the repo.
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
  const stableVolumePrefix = volumePrefix(app.name, ctx.envName);
  ctx.stableVolumePrefix = stableVolumePrefix;
  if (compose.volumes && Object.keys(compose.volumes).length > 0) {
    const externalized: string[] = [];
    // Shared-only volumes keep compose-native names so the shared project still finds its data.
    const { sharedOnly, crossBoundary } = volumesByOwner(compose);

    for (const volName of Object.keys(compose.volumes)) {
      if (isAnonymousVolume(volName)) continue;
      if (sharedOnly.has(volName)) continue;
      const stableName = crossBoundary.has(volName)
        ? crossBoundaryVolumeName(compose, volName, stableVolumePrefix)
        : `${stableVolumePrefix}_${volName}`;

      try {
        await execFileAsync("docker", ["volume", "create", stableName], { env: dockerEnv(), timeout: VOLUME_CREATE_TIMEOUT });
      } catch { /* already exists — fine */ }

      compose.volumes[volName] = { external: true, name: stableName };
      externalized.push(`${volName} → ${stableName}`);
    }

    if (externalized.length > 0) {
      log(`[deploy] Externalized ${externalized.length} volume(s): ${externalized.join(", ")}`);
    }
  }

  // Step 5a2: externalize networks a shared service attaches to, so both projects join one network.
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
          { env: dockerEnv(), timeout: VOLUME_CREATE_TIMEOUT },
        );
      } catch { /* already exists — fine */ }
      const external = { external: true, name: externalName };
      compose.networks[netName] = external;
      // The bare file must reference the external network too, or a pinned subnet clashes.
      // Key presence, not truthiness: `internal:` with no config parses to null.
      if (netName === DEFAULT_NETWORK || netName in ctx.bareCompose.networks) {
        ctx.bareCompose.networks[netName] = external;
      }
    }
    log(`[deploy] Shared network(s): ${[...sharedNets].join(", ")}`);
  }

  // Step 5b: write the bare and override compose files.
  const bareComposePath = join(slotDir, "docker-compose.yml");
  const overridePath = join(slotDir, "docker-compose.override.yml");

  for (const stale of [bareComposePath, overridePath, join(slotDir, ".env")]) {
    try { await rm(stale, { force: true }); } catch { /* gone already */ }
  }

  // Build contexts point at repoDir, not the slot: BuildKit won't follow the slot's symlinks out of the context.
  if (repoDir) {
    const buildRoot = appRootDir(repoDir, app.rootDirectory || ctx.hostConfig?.project?.rootDirectory);

    const rewriteBuildContext = (composeFile: typeof compose) => {
      for (const service of Object.values(composeFile.services)) {
        if (!service.build) continue;
        if (typeof service.build === "string") {
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

  // Exposed ports and per-service env from child app records.
  const serviceExposedPorts: Record<string, { internal: number; external?: number; protocol?: string }[]> = {};
  // Decrypted, unresolved env per decomposed child service.
  const serviceEnvRaw: Record<string, Record<string, string>> = {};
  if (Object.keys(compose.services).length > 1) {
    const childApps = await db.query.apps.findMany({
      where: and(
        eq(apps.parentAppId, app.id),
        eq(apps.organizationId, ctx.organizationId),
      ),
      columns: { id: true, composeService: true, exposedPorts: true, envContent: true },
    });
    for (const child of childApps) {
      if (!child.composeService) continue;
      if (ctx.envIsolated) {
        const own = await environmentEnvContent(child.id, ctx.envName);
        if (own !== null) child.envContent = own;
        else if (child.envContent) ctx.log(`[deploy] Warning: service ${child.composeService} has no ${ctx.envName} env of its own — deploying with production's`);
      }
      if (child.exposedPorts) {
        const ports = child.exposedPorts as { internal: number; external?: number; protocol?: string }[];
        if (ports.length > 0) {
          serviceExposedPorts[child.composeService] = ports;
        }
      }
      if (child.envContent) {
        const { content, decryptFailed } = decryptOrFallback(child.envContent, ctx.organizationId);
        if (decryptFailed) {
          throw new DeployBlockedError(
            `Could not decrypt environment variables for service "${child.composeService}" — check ENCRYPTION_MASTER_KEY.`,
          );
        }
        if (content) {
          const map = parseEnvToMap(content);
          if (Object.keys(map).length > 0) serviceEnvRaw[child.composeService] = map;
        }
      }
    }
  }
  // The parent's exposedPorts apply to the primary service.
  if (app.exposedPorts) {
    const parentPorts = app.exposedPorts as { internal: number; external?: number; protocol?: string }[];
    if (parentPorts.length > 0) {
      const primaryService = Object.keys(compose.services)[0];
      if (primaryService && !serviceExposedPorts[primaryService]) {
        serviceExposedPorts[primaryService] = parentPorts;
      }
    }
  }

  // Tier defaults below and in the compose overlay read the cached host size.
  await detectHost();

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

  const resolvedServiceEnv: Record<string, Record<string, string>> = {};

  // Resolve templates and write .env; child service env shares the same context.
  if (Object.keys(envMap).length > 0 || Object.keys(serviceEnvRaw).length > 0) {
    const orgVarRows = await db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, ctx.organizationId),
    });
    const orgEnvVarMap: Record<string, string> = {};
    // Legacy rows may still be plaintext.
    for (const v of orgVarRows) {
      const { content, decryptFailed } = decryptOrFallback(v.value, ctx.organizationId);
      if (decryptFailed) {
        throw new Error(
          `[deploy] Failed to decrypt org env var '${v.key}' — wrong key or corrupted data. Deploy aborted.`
        );
      }
      orgEnvVarMap[v.key] = content;
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
      resolveExternalVar: externalVarResolver({
        organizationId: ctx.organizationId,
        projectId: app.projectId,
        groupEnvironmentId: ctx.groupEnvironmentId,
        environmentName: ctx.envIsolated ? ctx.envName : undefined,
        log: ctx.log,
      }),
    };

    if (Object.keys(envMap).length > 0) {
      const resolved = await resolveAllEnvVars(envMap, resolveCtx);
      const envContent = composeEnvFile(resolved);
      await writeFile(join(slotDir, ".env"), envContent, "utf-8");
    }

    for (const [service, raw] of Object.entries(serviceEnvRaw)) {
      resolvedServiceEnv[service] = await resolveAllEnvVars(raw, resolveCtx);
    }
  }

  // Vardo's own secrets live on the host, not in its database.
  const seededEnv = await seedSelfEnv(app.name, appDir, slotDir, activeSlot, { log });
  if (seededEnv) {
    log(`[deploy] Seeded slot .env from ${seededEnv}`);
  } else if (isSelfApp(app.name)) {
    log(`[deploy] Warning: no .env found to seed — compose defaults would apply`);
  }

  await anchorSharedServicePaths(ctx);

  const certMount = await prepareCertMount(ctx, stableVolumePrefix);

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
    orgTrusted: ctx.orgTrusted,
    certMount,
  });

  await writeFile(bareComposePath, composeToYaml(ctx.bareCompose), "utf-8");
  await writeFile(overridePath, composeToYaml(overlayCompose), "utf-8");

  ctx.composeFileArgs = ["-f", bareComposePath, "-f", overridePath];

  await assertComposeWithinApp(ctx);

  // The repo-build path already closed compose and opened build in prepare-repo.
  if (!ctx.builtLocally) {
    ctx.stage("compose", "success");
    ctx.stage("build", "running");
  }

  return ctx;
}

/** The cert volume for opted-in services, filled before they start. Undefined when the app has it off. */
async function prepareCertMount(
  ctx: DeployContext,
  prefix: string,
): Promise<{ services: string[]; volume: string } | undefined> {
  const wanted = ctx.app.certServices ?? [];
  if (wanted.length === 0 || ctx.envIsolated) return undefined;
  const services = wanted.filter((s) => s in ctx.compose.services);
  const missing = wanted.filter((s) => !(s in ctx.compose.services));
  if (missing.length > 0) ctx.log(`[certs] No service named ${missing.join(", ")} — skipped`);
  if (services.length === 0) return undefined;

  const volume = `${prefix}_${CERTS_VOLUME_KEY}`;
  await execFileAsync("docker", ["volume", "create", volume], { env: dockerEnv(), timeout: VOLUME_CREATE_TIMEOUT });
  try {
    await syncAppCerts(ctx.app.id, ctx.log);
  } catch (err) {
    ctx.log(`[certs] Couldn't read Traefik's certificates yet: ${err instanceof Error ? err.message : err}`);
  }
  return { services, volume };
}

/** Repo entries the slot links or copies. Compose files and .env are Vardo's own. */
function isLinkedRepoEntry(entry: string): boolean {
  return !["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".env"].includes(entry);
}

/**
 * Point shared services' relative paths outside both slots so blue and green match.
 * Directories are never moved; one still in a slot is recorded so swap holds the service.
 */
export async function anchorSharedServicePaths(ctx: DeployContext): Promise<void> {
  const shared = nonRotatingServices(ctx.compose);
  if (shared.size === 0) return;
  const sharedDir = sharedPathsDir(ctx.appDir);
  const repoEntries = ctx.repoDir
    ? new Set((await readdir(ctx.repoDir).catch(() => [] as string[])).filter(isLinkedRepoEntry))
    : new Set<string>();
  const opts = { repoDir: ctx.repoDir, repoEntries, sharedDir };

  const anchored = anchorSharedPaths(ctx.compose, shared, opts);
  if (ctx.bareCompose !== ctx.compose) anchorSharedPaths(ctx.bareCompose, shared, opts);

  const isFile = (path: string) => stat(path).then((st) => st.isFile(), () => false);
  const exists = (path: string) => stat(path).then(() => true, () => false);

  for (const path of anchored) {
    ctx.log(`[deploy] Shared service ${path.service}: ${path.kind} ./${path.rel} → ${path.to}`);
    if (path.inRepo) continue;
    const inSlot = join(ctx.slotDir, path.rel);
    if (await isFile(inSlot)) {
      await mkdir(dirname(path.to), { recursive: true });
      await copyFile(inSlot, path.to);
      await chmod(path.to, (await stat(inSlot)).mode & 0o777);
      continue;
    }
    if (path.kind !== "volume" || (await exists(path.to))) continue;
    for (const slot of ["blue", "green"]) {
      const old = join(ctx.appDir, slot, path.rel);
      if (await exists(old)) {
        ((ctx.sharedPathMoves ??= {})[path.service] ??= []).push(`${old} → ${path.to}`);
      }
    }
  }
}
