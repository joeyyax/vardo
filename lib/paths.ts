// Host path resolution for all Vardo filesystem operations. Resolve paths here, never inline.
// VARDO_DIR is a fallback for VARDO_HOME_DIR.

import { resolve, join, relative, isAbsolute, sep } from "path";
import { accessSync, constants } from "fs";
import { mkdir, access, writeFile, readFile, readdir, rename, unlink } from "fs/promises";

/** Root directory for all Vardo data. */
export const VARDO_HOME_DIR = resolve(
  process.env.VARDO_HOME_DIR ||
    process.env.VARDO_DIR ||
    (process.env.NODE_ENV === "production" ? "/opt/vardo" : "./data"),
);

/** Where deployed app files live: compose, .env, blue/green slots. */
export const PROJECTS_DIR = resolve(
  process.env.VARDO_PROJECTS_DIR || join(VARDO_HOME_DIR, "apps"),
);

/** Where docker images are stored. */
export const IMAGES_DIR = resolve(
  process.env.VARDO_IMAGES_DIR || join(VARDO_HOME_DIR, "images"),
);

/** Where app directory ownership records live, one JSON file per directory name. */
export const APP_OWNERS_DIR = resolve(
  process.env.VARDO_APP_OWNERS_DIR || join(VARDO_HOME_DIR, "app-owners"),
);

/** Where Traefik dynamic config files are written. */
export const TRAEFIK_DYNAMIC_DIR = resolve(
  process.env.TRAEFIK_DYNAMIC_DIR ||
    (process.env.NODE_ENV === "production" ? "/etc/traefik/dynamic" : join(VARDO_HOME_DIR, "traefik")),
);

/** Base directory for an app (contains repo/ and env/). */
export function appBaseDir(appName: string): string {
  return join(PROJECTS_DIR, appName);
}

/** Environment directory for an app (contains blue/, green/, current symlink). */
export function appEnvDir(appName: string, envName?: string): string {
  if (envName) {
    return join(PROJECTS_DIR, appName, envName);
  }
  return join(PROJECTS_DIR, appName);
}

/** Specific slot directory (blue or green) within an app environment. */
export function appSlotDir(appName: string, envName: string, slot: string): string {
  return join(appEnvDir(appName, envName), slot);
}

/** App name owning `dir`, or null when `dir` is not inside PROJECTS_DIR. */
export function appNameFromPath(dir: string): string | null {
  const rel = relative(PROJECTS_DIR, resolve(dir));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep)[0] || null;
}

// App directory ownership: which app id owns a name-keyed directory. Guarded in lib/docker/app-dir-owner.ts.
// The registry (APP_OWNERS_DIR/<name>.json) is always written; the in-directory mirror is best effort.

/** Ownership marker filename, written at the root of an app's base directory. */
export const APP_OWNER_FILE = ".vardo-owner.json";

/** Path to an app's ownership marker. */
export function appOwnerFile(appName: string): string {
  return join(appBaseDir(appName), APP_OWNER_FILE);
}

/** Path to an app's registry record, or null when the name is not a single path segment. */
export function appOwnerRegistryFile(appName: string): string | null {
  if (!appName || appName.startsWith(".") || appName.includes("/") || appName.includes(sep)) return null;
  return join(APP_OWNERS_DIR, `${appName}.json`);
}

export type AppDirOwner =
  /** Ownership record present and parsed. */
  | { state: "owned"; appId: string; source: "marker" | "registry" }
  /** No directory on disk. */
  | { state: "missing" }
  /** Directory exists with no record. */
  | { state: "unmarked" }
  /** A record exists but could not be read or parsed. Never treat this as unmarked. */
  | { state: "unreadable"; reason: string };

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type OwnerRecord =
  | { kind: "owned"; appId: string }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

async function readOwnerRecord(file: string): Promise<OwnerRecord> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return { kind: "absent" };
    // Name the file — Node omits the path on some read errors.
    return { kind: "unreadable", reason: `${file}: ${errText(err)}` };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { appId?: unknown }).appId === "string") {
      const appId = (parsed as { appId: string }).appId;
      if (appId) return { kind: "owned", appId };
    }
  } catch {
    // A corrupt record is unreadable, not absent.
  }
  return { kind: "unreadable", reason: `${file} is malformed` };
}

async function writeOwnerRecord(file: string, appName: string, appId: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ appId, appName, claimedAt: new Date().toISOString() }, null, 2);
  // Rename so a reader never sees a half-written record and refuses on it.
  await writeFile(tmp, `${body}\n`, { mode: 0o644 });
  await rename(tmp, file);
}

/**
 * Read ownership for an app directory. The in-directory marker wins over the registry.
 * Non-ENOENT read failures report `unreadable`, never `unmarked`; callers must refuse.
 */
export async function readAppDirOwner(appName: string): Promise<AppDirOwner> {
  const marker = await readOwnerRecord(appOwnerFile(appName));
  if (marker.kind === "owned") return { state: "owned", appId: marker.appId, source: "marker" };
  if (marker.kind === "unreadable") return { state: "unreadable", reason: marker.reason };

  try {
    await access(appBaseDir(appName));
  } catch (dirErr) {
    if (isNotFound(dirErr)) return { state: "missing" };
    return { state: "unreadable", reason: `${appBaseDir(appName)}: ${errText(dirErr)}` };
  }

  const registryFile = appOwnerRegistryFile(appName);
  if (!registryFile) return { state: "unmarked" };

  const record = await readOwnerRecord(registryFile);
  if (record.kind === "owned") return { state: "owned", appId: record.appId, source: "registry" };
  if (record.kind === "unreadable") return { state: "unreadable", reason: record.reason };
  return { state: "unmarked" };
}

/** Copy the ownership record into the app's directory. False when the directory isn't writable. */
export async function mirrorAppDirOwner(appName: string, appId: string): Promise<boolean> {
  try {
    const dir = appBaseDir(appName);
    await mkdir(dir, { recursive: true });
    await writeOwnerRecord(join(dir, APP_OWNER_FILE), appName, appId);
    return true;
  } catch {
    return false;
  }
}

/** Record ownership in the registry, then mirror it. Throws only when the registry write fails. */
export async function writeAppDirOwner(
  appName: string,
  appId: string,
): Promise<{ mirrored: boolean }> {
  const registryFile = appOwnerRegistryFile(appName);
  if (!registryFile) throw new Error(`"${appName}" is not a usable app directory name`);

  await mkdir(APP_OWNERS_DIR, { recursive: true });
  await writeOwnerRecord(registryFile, appName, appId);
  return { mirrored: await mirrorAppDirOwner(appName, appId) };
}

/** Drop an app directory's registry record. */
export async function removeAppDirOwner(appName: string): Promise<void> {
  const registryFile = appOwnerRegistryFile(appName);
  if (!registryFile) return;
  try {
    await unlink(registryFile);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** App directory names holding a registry record. */
export async function listAppDirOwners(): Promise<string[]> {
  try {
    const entries = await readdir(APP_OWNERS_DIR);
    return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

// Vardo's own app layout: apps/vardo/env/blue|green|current. Runtime references go through `current`.

/** Root of Vardo's self-managed app directory. */
export const VARDO_APP_DIR = join(PROJECTS_DIR, "vardo");

/** Environment directory for Vardo's slots. */
export const VARDO_ENV_DIR = join(VARDO_APP_DIR, "env");

/** The `current` symlink to the active slot. */
export const VARDO_CURRENT_DIR = join(VARDO_ENV_DIR, "current");

/** Compose file in the active slot. */
export const VARDO_COMPOSE_FILE = join(VARDO_CURRENT_DIR, "docker-compose.yml");

/** Slot directory (blue or green). */
export function vardoSlotDir(slot: "blue" | "green"): string {
  return join(VARDO_ENV_DIR, slot);
}

/** Create missing data directories and return the ones that aren't writable. */
export async function ensureDataDirs(): Promise<string[]> {
  const dirs = [VARDO_HOME_DIR, PROJECTS_DIR, IMAGES_DIR, APP_OWNERS_DIR];
  const failures: string[] = [];

  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // Parent not writable.
    }

    try {
      await access(dir, constants.W_OK);
      // NFS/FUSE mounts can lie about W_OK.
      const probe = join(dir, `.vardo-write-probe-${process.pid}`);
      await writeFile(probe, "");
      await unlink(probe);
    } catch {
      failures.push(dir);
    }
  }

  return failures;
}

/** Vardo's compose file: the active slot's, or $VARDO_HOME_DIR/docker-compose.yml on legacy flat installs. */
export function resolveVardoComposeFile(): string {
  try {
    accessSync(VARDO_COMPOSE_FILE);
    return VARDO_COMPOSE_FILE;
  } catch {
    return join(VARDO_HOME_DIR, "docker-compose.yml");
  }
}

/** Vardo's source directory: VARDO_CURRENT_DIR, or VARDO_HOME_DIR on legacy flat installs. */
export function resolveVardoDir(): string {
  try {
    accessSync(VARDO_CURRENT_DIR);
    return VARDO_CURRENT_DIR;
  } catch {
    return VARDO_HOME_DIR;
  }
}
