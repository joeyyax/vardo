// ---------------------------------------------------------------------------
// The data an app keeps on the host: its Docker volumes and the bind-mounted
// paths inside its directory. Deleting an app destroys these only on request,
// and the confirmation lists exactly what this returns.
// ---------------------------------------------------------------------------

import { readdir, readFile, realpath, lstat } from "fs/promises";
import { join, relative, isAbsolute, sep } from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";
import { appBaseDir } from "@/lib/paths";
import { execFileAsync } from "@/lib/utils/exec";
import { getVolumeSizes, listVolumes, type VolumeInfo } from "./client";
import { parseCompose } from "./compose-parse";
import { bindMountHostSource } from "./deploy-steps/bind-mount-ownership";

export type AppVolume = { name: string; sizeBytes: number | null };
export type AppBindMount = { path: string; sizeBytes: number | null };
export type AppData = { volumes: AppVolume[]; bindMounts: AppBindMount[] };

const SLOT_DIRS = ["blue", "green", "local"];
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.override.yml"];

/** Inside `dir`, or `dir` itself. */
function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Volume names that belong to an app.
 *
 * Externalized volumes (`<app>-<env>_<volume>`) carry no compose labels, so they
 * match by name; everything compose created matches by project. A name another
 * app could also claim (`api` vs `api-v2`) is left out.
 */
export function matchAppVolumes(
  volumes: VolumeInfo[],
  opts: { appName: string; envNames: string[]; composeNames?: string[]; otherAppNames: string[] },
): string[] {
  const { appName } = opts;
  const projects = new Set([appName, `${appName}-blue`, `${appName}-green`]);
  const prefixes: string[] = [];
  for (const env of opts.envNames) {
    const base = `${appName}-${env}`;
    for (const p of [base, `${base}-blue`, `${base}-green`, `${base}-shared`]) projects.add(p);
    prefixes.push(`${base}_`);
  }

  const others = opts.otherAppNames.filter((n) => n !== appName);
  const claimedByOther = (name: string) =>
    others.some((o) => name === o || name.startsWith(`${o}-`) || name.startsWith(`${o}_`));

  for (const composeName of opts.composeNames ?? []) {
    if (claimedByOther(composeName)) continue;
    projects.add(composeName);
    prefixes.push(`${composeName}_`);
  }

  const matched: string[] = [];
  for (const vol of volumes) {
    const project = vol.labels["com.docker.compose.project"];
    const owned = project
      ? projects.has(project) && !claimedByOther(project)
      : prefixes.some((p) => vol.name.startsWith(p));
    if (!owned || claimedByOther(vol.name)) continue;
    matched.push(vol.name);
  }
  return matched.sort();
}

async function slotDirsOf(baseDir: string): Promise<string[]> {
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(baseDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== "repo")
      .map((e) => e.name);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (SLOT_DIRS.includes(entry)) {
      dirs.push(join(baseDir, entry));
      continue;
    }
    for (const slot of SLOT_DIRS) dirs.push(join(baseDir, entry, slot));
  }
  return dirs;
}

/** Environment directory names on disk, for envs whose rows are already gone. */
async function envDirNames(baseDir: string): Promise<string[]> {
  try {
    return (await readdir(baseDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== "repo" && !SLOT_DIRS.includes(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Bind sources inside the app's directory, read from the compose files each
 * slot was deployed with. Symlinked sources are listed with their target too,
 * so the data behind a link into `repo/` is kept along with the link.
 */
export async function scanAppDir(appName: string): Promise<{
  bindPaths: string[];
  composeNames: string[];
}> {
  const baseDir = appBaseDir(appName);
  const bindPaths = new Set<string>();
  const composeNames = new Set<string>();
  const realBase = await realpath(baseDir).catch(() => baseDir);

  for (const slotDir of await slotDirsOf(baseDir)) {
    for (const file of COMPOSE_FILES) {
      let compose;
      try {
        compose = parseCompose(await readFile(join(slotDir, file), "utf8"));
      } catch {
        continue;
      }
      if (compose.name) composeNames.add(compose.name);
      for (const service of Object.values(compose.services)) {
        for (const vol of service.volumes ?? []) {
          const source = bindMountHostSource(vol, slotDir);
          if (!source || !isWithin(baseDir, source)) continue;
          try {
            await lstat(source);
          } catch {
            continue;
          }
          bindPaths.add(source);
          try {
            const real = await realpath(source);
            if (isWithin(realBase, real)) bindPaths.add(join(baseDir, relative(realBase, real)));
          } catch { /* dangling link */ }
        }
      }
    }
  }

  return { bindPaths: [...bindPaths].sort(), composeNames: [...composeNames] };
}

/** Docker's volume df walks every volume on the host; hundreds take tens of seconds. */
export const VOLUME_SIZES_TIMEOUT_MS = 3000;
export const PATH_SIZE_TIMEOUT_MS = 3000;

async function measurePath(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-sb", path], { timeout: PATH_SIZE_TIMEOUT_MS });
    const bytes = parseInt(stdout.split("\t")[0], 10);
    return Number.isNaN(bytes) ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Volumes and bind-mounted paths owned by an app. A decomposed child owns none
 * of its own: they belong to the parent's stack.
 */
export async function findAppData(
  app: { id: string; name: string; parentAppId?: string | null },
): Promise<AppData> {
  if (app.parentAppId) return { volumes: [], bindMounts: [] };

  const baseDir = appBaseDir(app.name);
  const [envRows, appRows, scan, diskEnvs, dockerVolumes] = await Promise.all([
    db.query.environments.findMany({
      where: eq(environments.appId, app.id),
      columns: { name: true },
    }),
    db.query.apps.findMany({ columns: { name: true } }),
    scanAppDir(app.name),
    envDirNames(baseDir),
    listVolumes(),
  ]);

  const names = matchAppVolumes(dockerVolumes, {
    appName: app.name,
    envNames: [...new Set([...envRows.map((e) => e.name), ...diskEnvs])],
    composeNames: scan.composeNames,
    otherAppNames: appRows.map((a) => a.name),
  });

  // A kept parent covers its children; only the outermost paths are listed.
  const outermost = scan.bindPaths.filter(
    (p) => !scan.bindPaths.some((q) => q !== p && p.startsWith(q + sep)),
  );

  return {
    volumes: names.map((name) => ({ name, sizeBytes: null })),
    bindMounts: outermost.map((path) => ({ path, sizeBytes: null })),
  };
}

/** Resolves to `fallback` once `ms` passes. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fill in sizes, best effort. Each source is bounded; a size that isn't back in
 * time stays null.
 */
export async function measureAppData(data: AppData): Promise<AppData> {
  const [volumeSizes, bindSizes] = await Promise.all([
    within(
      getVolumeSizes({ timeoutMs: VOLUME_SIZES_TIMEOUT_MS }),
      VOLUME_SIZES_TIMEOUT_MS,
      new Map<string, number>(),
    ),
    Promise.all(
      data.bindMounts.map((b) => within(measurePath(b.path), PATH_SIZE_TIMEOUT_MS, null)),
    ),
  ]);
  return {
    volumes: data.volumes.map((v) => ({ ...v, sizeBytes: volumeSizes.get(v.name) ?? null })),
    bindMounts: data.bindMounts.map((b, i) => ({ ...b, sizeBytes: bindSizes[i] })),
  };
}

/** Every bind path to preserve, symlinks and their targets alike. */
export async function appBindPaths(appName: string): Promise<string[]> {
  return (await scanAppDir(appName)).bindPaths;
}
