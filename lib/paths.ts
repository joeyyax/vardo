// ---------------------------------------------------------------------------
// Centralized path resolution for all Vardo filesystem operations.
//
// Every host path used by deploy, compose, traefik config, logs, and rollback
// monitoring should be resolved through this module — never inline.
//
// Hierarchy:
//   VARDO_HOME_DIR          → root of all Vardo data (default: /opt/vardo)
//   VARDO_PROJECTS_DIR      → app deployment files  (default: $VARDO_HOME_DIR/apps)
//   VARDO_IMAGES_DIR        → docker image storage   (default: $VARDO_HOME_DIR/images)
//   VARDO_APP_OWNERS_DIR    → app directory ownership (default: $VARDO_HOME_DIR/app-owners)
//   TRAEFIK_DYNAMIC_DIR     → traefik route configs  (default: /etc/traefik/dynamic, shared volume)
//
// Individual overrides take precedence over derived defaults.
// VARDO_DIR is accepted as a fallback for VARDO_HOME_DIR (backwards compat).
// ---------------------------------------------------------------------------

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

/** Where Traefik dynamic config files are written (shared volume between frontend and traefik). */
export const TRAEFIK_DYNAMIC_DIR = resolve(
  process.env.TRAEFIK_DYNAMIC_DIR ||
    (process.env.NODE_ENV === "production" ? "/etc/traefik/dynamic" : join(VARDO_HOME_DIR, "traefik")),
);

// ---------------------------------------------------------------------------
// App path helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App directory ownership
//
// App directories are keyed by name, so two organizations that use the same app
// name resolve to one directory. Ownership records which app id owns it; see
// lib/docker/app-dir-owner.ts for the guard that reads it.
//
// Written in two places:
//   APP_OWNERS_DIR/<name>.json     registry, always written
//   apps/<name>/.vardo-owner.json  mirror, only when the directory is writable
//
// Vardo runs unprivileged and app directories predating it are owned by another
// uid, so the mirror is best effort. The registry lives under VARDO_HOME_DIR,
// which the process always owns.
//
// Survivability: both are on disk, so ownership outlives the database being lost
// or restored. Only the mirror survives the directory being moved. Neither
// survives losing VARDO_HOME_DIR.
// ---------------------------------------------------------------------------

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
  /** No directory on disk — there is nothing to guard. */
  | { state: "missing" }
  /** Directory exists with no record (predates ownership, or never claimed). */
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
    // Fall through — a corrupt record is unreadable, not absent.
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
 * Read ownership for an app directory. The in-directory marker wins over the
 * registry — it travels with the directory, so it is the stronger claim.
 *
 * A read failure that is not ENOENT reports `unreadable`, never `unmarked` —
 * callers must refuse rather than assume the directory is unclaimed.
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

/**
 * Copy the ownership record into the app's own directory so it stays
 * attributable if moved. False when the directory is not writable by this process.
 */
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

/**
 * Record ownership in the registry, then mirror it into the app directory.
 * Throws only when the registry write fails.
 */
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

// ---------------------------------------------------------------------------
// Vardo self-management paths
//
// Vardo manages itself as an app in apps/vardo/env/blue|green|current/.
// These helpers resolve paths within that structure. The `current` symlink
// points to the active slot — all runtime references should go through it.
// ---------------------------------------------------------------------------

/** Root of Vardo's self-managed app directory: $VARDO_HOME_DIR/apps/vardo */
export const VARDO_APP_DIR = join(PROJECTS_DIR, "vardo");

/** Environment directory for Vardo's slots: apps/vardo/env/ */
export const VARDO_ENV_DIR = join(VARDO_APP_DIR, "env");

/** The `current` symlink — always points to the active slot. */
export const VARDO_CURRENT_DIR = join(VARDO_ENV_DIR, "current");

/** Compose file in the active slot. */
export const VARDO_COMPOSE_FILE = join(VARDO_CURRENT_DIR, "docker-compose.yml");

/** Resolve a specific slot directory (blue or green). */
export function vardoSlotDir(slot: "blue" | "green"): string {
  return join(VARDO_ENV_DIR, slot);
}

// ---------------------------------------------------------------------------
// Startup directory verification
// ---------------------------------------------------------------------------

/**
 * Ensure required data directories exist and are writable.
 *
 * Called once at startup from instrumentation.ts. Returns a list of
 * directories that failed — empty means everything is fine.
 *
 * Cannot fix ownership (we don't run as root), but creates missing dirs
 * if the parent is writable and reports clear errors when not.
 */
export async function ensureDataDirs(): Promise<string[]> {
  const dirs = [VARDO_HOME_DIR, PROJECTS_DIR, IMAGES_DIR, APP_OWNERS_DIR];
  const failures: string[] = [];

  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // mkdir failed — parent not writable
    }

    try {
      await access(dir, constants.W_OK);
      // Verify actual write capability (NFS/FUSE mounts can lie about W_OK)
      const probe = join(dir, `.vardo-write-probe-${process.pid}`);
      await writeFile(probe, "");
      await unlink(probe);
    } catch {
      failures.push(dir);
    }
  }

  return failures;
}

/**
 * Resolve Vardo's compose file at runtime with legacy fallback.
 *
 * Returns VARDO_COMPOSE_FILE (active slot) if the current symlink exists,
 * otherwise falls back to $VARDO_HOME_DIR/docker-compose.yml for legacy
 * flat installs that haven't migrated yet.
 */
export function resolveVardoComposeFile(): string {
  try {
    accessSync(VARDO_COMPOSE_FILE);
    return VARDO_COMPOSE_FILE;
  } catch {
    return join(VARDO_HOME_DIR, "docker-compose.yml");
  }
}

/**
 * Resolve Vardo's source directory at runtime with legacy fallback.
 *
 * Returns VARDO_CURRENT_DIR if the slot layout exists, otherwise
 * VARDO_HOME_DIR for legacy flat installs.
 */
export function resolveVardoDir(): string {
  try {
    accessSync(VARDO_CURRENT_DIR);
    return VARDO_CURRENT_DIR;
  } catch {
    return VARDO_HOME_DIR;
  }
}
