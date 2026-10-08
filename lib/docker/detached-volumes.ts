// Volumes and app directories left behind by deleted apps. Deleting an app keeps them by default (#829).

import { readdir, rm } from "fs/promises";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { PROJECTS_DIR, appBaseDir, removeAppDirOwner } from "@/lib/paths";
import { listAllContainers, listMountedVolumeNames, listVolumes, removeVolume, getVolumeSizes, type VolumeInfo } from "./client";
import { matchAppVolumes, measurePath, scanAppDir, within, VOLUME_SIZES_TIMEOUT_MS, PATH_SIZE_TIMEOUT_MS } from "./app-data";
import { isSelfApp } from "./self-env";

export type DetachedVolume = {
  name: string;
  /** The deleted app the volume came from. */
  sourceApp: string;
  sizeBytes: number | null;
};

export type DetachedDir = {
  /** Directory name under the apps directory, which is the app name. */
  name: string;
  path: string;
  sizeBytes: number | null;
};

export type Detached = { volumes: DetachedVolume[]; dirs: DetachedDir[] };

/** Everything the decision reads, gathered once. */
export type Snapshot = {
  volumes: VolumeInfo[];
  /** Names of volumes any container mounts. */
  mounted: Set<string>;
  /** Compose projects that still have a container. */
  containerProjects: Set<string>;
  /** Volume names a live app owns. */
  liveVolumes: Set<string>;
  liveAppNames: Set<string>;
  /** Volume names that app.deleted activity recorded as kept, with the app that kept them. */
  keptByDeletedApp: Map<string, string>;
  /** Directory names under the apps directory. */
  dirNames: string[];
};

/** Compose projects a directory named `appName` deploys under. */
function projectsOf(appName: string): string[] {
  return [appName, `${appName}-blue`, `${appName}-green`];
}

/**
 * Volumes with a deleted app behind them and nothing live in front. Provenance is the delete record
 * or an orphaned app directory; a compose project label alone never qualifies, since the host runs
 * stacks Vardo knows nothing about, its own included.
 */
export function resolveDetached(snap: Snapshot): { volumes: Omit<DetachedVolume, "sizeBytes">[]; dirs: Omit<DetachedDir, "sizeBytes">[] } {
  const dirs = snap.dirNames
    .filter((name) => !isSelfApp(name) && !snap.liveAppNames.has(name))
    .sort();

  const orphanProjects = new Map<string, string>();
  for (const name of dirs) for (const p of projectsOf(name)) orphanProjects.set(p, name);

  const volumes: Omit<DetachedVolume, "sizeBytes">[] = [];
  for (const vol of snap.volumes) {
    if (snap.liveVolumes.has(vol.name) || snap.mounted.has(vol.name)) continue;
    const project = vol.labels["com.docker.compose.project"];
    if (project && (snap.containerProjects.has(project) || isSelfApp(project))) continue;
    if (project && snap.liveAppNames.has(project)) continue;

    const sourceApp = snap.keptByDeletedApp.get(vol.name) ?? (project ? orphanProjects.get(project) : undefined);
    if (!sourceApp || snap.liveAppNames.has(sourceApp) || isSelfApp(sourceApp)) continue;
    volumes.push({ name: vol.name, sourceApp });
  }
  volumes.sort((a, b) => a.name.localeCompare(b.name));

  return {
    volumes,
    dirs: dirs.map((name) => ({ name, path: appBaseDir(name) })),
  };
}

async function loadKeptByDeletedApp(): Promise<Map<string, string>> {
  const rows = await db.query.activities.findMany({
    where: eq(activities.action, "app.deleted"),
    columns: { metadata: true },
  });
  const kept = new Map<string, string>();
  for (const { metadata } of rows) {
    const m = metadata as { name?: unknown; keptVolumes?: unknown } | null;
    if (typeof m?.name !== "string" || !Array.isArray(m.keptVolumes)) continue;
    for (const v of m.keptVolumes) if (typeof v === "string") kept.set(v, m.name);
  }
  return kept;
}

async function loadDirNames(): Promise<string[]> {
  try {
    return (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [volumes, mounted, containers, appRows, envRows, kept, dirNames] = await Promise.all([
    listVolumes(),
    listMountedVolumeNames(),
    listAllContainers(),
    db.query.apps.findMany({ columns: { id: true, name: true, parentAppId: true } }),
    db.query.environments.findMany({ columns: { appId: true, name: true } }),
    loadKeptByDeletedApp(),
    loadDirNames(),
  ]);

  const liveAppNames = new Set(appRows.map((a) => a.name));
  const liveVolumes = new Set<string>();
  for (const app of appRows) {
    if (app.parentAppId) continue;
    const scan = await scanAppDir(app.name);
    for (const name of matchAppVolumes(volumes, {
      appName: app.name,
      envNames: envRows.filter((e) => e.appId === app.id).map((e) => e.name),
      composeNames: scan.composeNames,
      otherAppNames: [...liveAppNames],
    })) liveVolumes.add(name);
  }

  const containerProjects = new Set<string>();
  for (const c of containers) {
    const p = c.labels["com.docker.compose.project"];
    if (p) containerProjects.add(p);
  }

  return { volumes, mounted, containerProjects, liveVolumes, liveAppNames, keptByDeletedApp: kept, dirNames };
}

/** Names only. Sizes come from measureDetached. */
export async function findDetached(load: () => Promise<Snapshot> = loadSnapshot): Promise<Detached> {
  const found = resolveDetached(await load());
  return {
    volumes: found.volumes.map((v) => ({ ...v, sizeBytes: null })),
    dirs: found.dirs.map((d) => ({ ...d, sizeBytes: null })),
  };
}

/** Fills in sizes, best effort. A size that times out stays null. */
export async function measureDetached(data: Detached): Promise<Detached> {
  const [volumeSizes, dirSizes] = await Promise.all([
    within(getVolumeSizes({ timeoutMs: VOLUME_SIZES_TIMEOUT_MS }), VOLUME_SIZES_TIMEOUT_MS, new Map<string, number>()),
    Promise.all(data.dirs.map((d) => within(measurePath(d.path), PATH_SIZE_TIMEOUT_MS, null))),
  ]);
  return {
    volumes: data.volumes.map((v) => ({ ...v, sizeBytes: volumeSizes.get(v.name) ?? null })),
    dirs: data.dirs.map((d, i) => ({ ...d, sizeBytes: dirSizes[i] })),
  };
}

/** Thrown when the target isn't detached right now. */
export class NotDetachedError extends Error {
  constructor(readonly kind: "volume" | "dir", readonly target: string) {
    super(`"${target}" isn't a detached ${kind === "volume" ? "volume" : "directory"}.`);
    this.name = "NotDetachedError";
  }
}

/** Remove one detached volume. Rechecks against live state and never forces. */
export async function deleteDetachedVolume(
  name: string,
  deps: { load?: () => Promise<Snapshot>; remove?: (name: string) => Promise<void> } = {},
): Promise<void> {
  const { volumes } = resolveDetached(await (deps.load ?? loadSnapshot)());
  if (!volumes.some((v) => v.name === name)) throw new NotDetachedError("volume", name);
  await (deps.remove ?? removeVolume)(name);
}

/** Remove one orphaned app directory. Rechecks against live state. */
export async function deleteDetachedDir(
  name: string,
  deps: { load?: () => Promise<Snapshot>; remove?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const { dirs } = resolveDetached(await (deps.load ?? loadSnapshot)());
  const dir = dirs.find((d) => d.name === name);
  if (!dir) throw new NotDetachedError("dir", name);
  await (deps.remove ?? ((p) => rm(p, { recursive: true, force: true })))(join(PROJECTS_DIR, dir.name));
  await removeAppDirOwner(dir.name).catch(() => {});
}
