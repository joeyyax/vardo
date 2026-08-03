// ---------------------------------------------------------------------------
// App directory ownership guard.
//
// `$VARDO_HOME/apps/<name>` is derived from the app name, which is unique only
// per organization — two orgs can resolve to the same directory. Anything that
// tears down containers, removes volumes, or deletes files under a name-derived
// path must call assertAppDirOwnership first.
//
// WARNING: adding another destructive path-based operation without this check
// re-opens cross-organization deletion.
// ---------------------------------------------------------------------------

import { access, readdir, rm } from "fs/promises";
import { constants } from "fs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  APP_OWNERS_DIR,
  APP_OWNER_FILE,
  PROJECTS_DIR,
  appBaseDir,
  appNameFromPath,
  appOwnerFile,
  appOwnerRegistryFile,
  listAppDirOwners,
  mirrorAppDirOwner,
  readAppDirOwner,
  removeAppDirOwner,
  writeAppDirOwner,
} from "@/lib/paths";
import { APP_UID } from "./constants";
import { isSelfApp } from "./self-env";

const log = logger.child("app-dir-owner");

/** Thrown when an app directory does not belong to the app asking. */
export class AppDirOwnershipError extends Error {
  readonly appId: string;
  readonly appName: string;

  constructor(message: string, appId: string, appName: string) {
    super(message);
    this.name = "AppDirOwnershipError";
    this.appId = appId;
    this.appName = appName;
  }
}

/** Where the claim on `appName` is recorded. */
function ownerRecordPath(appName: string, source: "marker" | "registry"): string {
  if (source === "marker") return appOwnerFile(appName);
  return appOwnerRegistryFile(appName) ?? APP_OWNERS_DIR;
}

/** Apps in the database claiming a top-level app name, across all organizations. */
async function claimants(appName: string): Promise<string[]> {
  const rows = await db.query.apps.findMany({
    where: eq(apps.name, appName),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Refuse a destructive operation unless `appId` owns the app directory.
 *
 * - record matches → allowed
 * - record names another app, or cannot be read → refused
 * - no directory → allowed, nothing to destroy
 * - directory with no record → adopted only when exactly one app in the
 *   database claims the name, then stamped
 *
 * Vardo's own directory is exempt: install.sh creates it and the running
 * process deploys it, so its marker can never be authoritative.
 */
export async function assertAppDirOwnership(opts: {
  appId: string;
  appName: string;
  /** Verb used in the refusal, e.g. "stop" or "delete". */
  operation: string;
}): Promise<void> {
  const { appId, appName, operation } = opts;
  if (isSelfApp(appName)) return;

  const owner = await readAppDirOwner(appName);
  const dir = appBaseDir(appName);

  switch (owner.state) {
    case "owned":
      if (owner.appId === appId) return;
      throw new AppDirOwnershipError(
        `Refusing to ${operation} "${appName}": ${dir} is owned by app ${owner.appId}, not ${appId} ` +
          `(recorded in ${ownerRecordPath(appName, owner.source)}). ` +
          `Rename this app so it gets its own directory.`,
        appId,
        appName,
      );

    case "missing":
      return;

    case "unreadable":
      throw new AppDirOwnershipError(
        `Refusing to ${operation} "${appName}": the ownership record could not be read (${owner.reason}). ` +
          `Fix the record before retrying — an unreadable record is not an absent one.`,
        appId,
        appName,
      );

    case "unmarked": {
      const ids = await claimants(appName);
      if (ids.length !== 1 || ids[0] !== appId) {
        throw new AppDirOwnershipError(
          `Refusing to ${operation} "${appName}": ${dir} predates ownership records and ${ids.length} apps claim the name. ` +
            `Rename the duplicates so one app owns the directory.`,
          appId,
          appName,
        );
      }
      // Uniqueness is the authorization; the stamp is bookkeeping.
      try {
        await writeAppDirOwner(appName, appId);
      } catch (err) {
        log.warn(`Could not record ownership for ${appName} in ${APP_OWNERS_DIR}:`, err);
      }
      return;
    }
  }
}

/** Outcome of removing an app's base directory. */
export type AppDirRemoval = {
  removed: boolean;
  /** Why the directory survived. */
  reason?: string;
};

/**
 * Remove an app's base directory and drop its ownership record.
 *
 * Guarded by assertAppDirOwnership, which throws when the directory belongs to
 * another app. A directory this process cannot remove is reported rather than
 * thrown — Vardo runs unprivileged and many app directories are owned by another
 * uid, so a surviving directory must not fail an otherwise complete delete.
 *
 * The record is dropped either way. It names an app that no longer exists, and
 * keeping it would refuse every later use of the name.
 *
 * Call before the app row is deleted — the guard adopts an unmarked directory by
 * resolving the name against the database.
 */
export async function removeAppDir(opts: {
  appId: string;
  appName: string;
}): Promise<AppDirRemoval> {
  const { appId, appName } = opts;
  if (isSelfApp(appName)) return { removed: false, reason: "Vardo's own directory" };

  await assertAppDirOwnership({ appId, appName, operation: "delete" });

  let removed = true;
  let reason: string | undefined;
  try {
    await rm(appBaseDir(appName), { recursive: true, force: true });
  } catch (err) {
    removed = false;
    reason = errText(err);
    // A surviving marker would keep the name claimed by a deleted app.
    await rm(appOwnerFile(appName), { force: true }).catch(() => {});
  }

  try {
    await removeAppDirOwner(appName);
  } catch (err) {
    log.warn(`Could not drop the ownership record for ${appName}:`, err);
  }

  return removed ? { removed } : { removed, reason };
}

/**
 * Stamp ownership on the app base directory containing `dir`, when the database
 * names exactly one app. Best effort — callers create directories regardless.
 *
 * An ambiguous name is left unmarked so the destructive guard refuses instead.
 */
export async function stampAppDirOwner(dir: string): Promise<void> {
  const appName = appNameFromPath(dir);
  if (!appName || isSelfApp(appName)) return;

  const owner = await readAppDirOwner(appName);
  if (owner.state !== "unmarked") return;

  const ids = await claimants(appName);
  if (ids.length !== 1) return;
  await writeAppDirOwner(appName, ids[0]);
}

// ---------------------------------------------------------------------------
// Fleet-wide stamping pass
//
// Records an owner for every app directory and reports coverage. Adoption
// resolves a name against the database, so it only works while top-level names
// are unique.
// ---------------------------------------------------------------------------

/** Why a directory could not be given an owner. Each needs a hand to resolve. */
export type AppDirOwnerGapReason =
  /** Ownership record present but unparseable. */
  | "unreadable"
  /** No app in the database claims the name — an orphaned directory on disk. */
  | "orphaned"
  /** More than one app claims the name. */
  | "ambiguous"
  /** The registry itself could not be written. */
  | "unwritable"
  /** Read or write failed. */
  | "failed";

export type AppDirOwnerGap = {
  appName: string;
  dir: string;
  reason: AppDirOwnerGapReason;
  detail: string;
};

export type AppDirOwnerReport = {
  /** App directories found on disk. */
  total: number;
  /** Records written, or writable when `dryRun`. */
  stamped: number;
  /** Directories that already named an owner. */
  alreadyOwned: number;
  /** Vardo's own directory, whose record can never be authoritative. */
  exempt: number;
  /** Directories left without an owner, each named with its reason. */
  gaps: AppDirOwnerGap[];
  /** Owned via the registry alone — the directory is not writable, so it carries no marker. */
  unmirrored: string[];
  /** Registry records dropped because the directory is gone. */
  pruned: number;
  dryRun: boolean;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDenied(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Re-attempt the in-directory mirror. A dry run only reports whether it could. */
async function tryMirror(appName: string, appId: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return isWritable(appBaseDir(appName));
  return mirrorAppDirOwner(appName, appId);
}

/**
 * Directory names directly under PROJECTS_DIR. Empty on a fresh install.
 * Symlinks are included so a linked app directory is never silently skipped.
 */
async function appDirNames(): Promise<string[]> {
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Drop registry records for directories that are gone, so a name reused later
 * cannot inherit a stale claim.
 *
 * Skipped when the apps directory reads empty — an unmounted volume looks the
 * same and would wipe every record.
 */
async function pruneRegistry(present: string[], dryRun: boolean): Promise<number> {
  if (present.length === 0) return 0;
  const kept = new Set(present);
  const stale = (await listAppDirOwners()).filter((name) => !kept.has(name));
  if (!dryRun) for (const name of stale) await removeAppDirOwner(name);
  return stale.length;
}

/**
 * Record an owner for every unclaimed app directory.
 *
 * `dryRun` surveys without writing. `total` always equals
 * `stamped + alreadyOwned + exempt + gaps.length`.
 */
export async function stampAllAppDirOwners(
  opts: { dryRun?: boolean } = {},
): Promise<AppDirOwnerReport> {
  const dryRun = opts.dryRun ?? false;
  const names = await appDirNames();
  const report: AppDirOwnerReport = {
    total: names.length,
    stamped: 0,
    alreadyOwned: 0,
    exempt: 0,
    gaps: [],
    unmirrored: [],
    pruned: 0,
    dryRun,
  };

  for (const appName of names) {
    const dir = appBaseDir(appName);
    const gap = (reason: AppDirOwnerGapReason, detail: string) =>
      report.gaps.push({ appName, dir, reason, detail });

    if (isSelfApp(appName)) {
      report.exempt++;
      continue;
    }

    try {
      const owner = await readAppDirOwner(appName);
      if (owner.state === "owned") {
        report.alreadyOwned++;
        // Self-heals once the directory becomes writable.
        if (owner.source === "registry" && !(await tryMirror(appName, owner.appId, dryRun))) {
          report.unmirrored.push(appName);
        }
        continue;
      }
      if (owner.state === "unreadable") {
        gap("unreadable", owner.reason);
        continue;
      }
      if (owner.state === "missing") {
        gap("failed", "directory disappeared during the pass");
        continue;
      }

      const ids = await claimants(appName);
      if (ids.length === 0) {
        gap("orphaned", "no app in the database claims this name");
        continue;
      }
      if (ids.length > 1) {
        gap("ambiguous", `${ids.length} apps claim this name: ${ids.join(", ")}`);
        continue;
      }

      const mirrored = dryRun
        ? await isWritable(dir)
        : (await writeAppDirOwner(appName, ids[0])).mirrored;
      if (!mirrored) report.unmirrored.push(appName);
      report.stamped++;
    } catch (err) {
      gap(isDenied(err) ? "unwritable" : "failed", errText(err));
    }
  }

  try {
    report.pruned = await pruneRegistry(names, dryRun);
  } catch (err) {
    log.warn(`Could not prune ${APP_OWNERS_DIR}:`, err);
  }

  return report;
}

/** One-line coverage summary — the number that gates dropping the name index. */
export function summarizeAppDirOwners(report: AppDirOwnerReport): string {
  const owned = report.stamped + report.alreadyOwned;
  const noun = report.total === 1 ? "directory" : "directories";
  const head = report.dryRun
    ? `${owned} of ${report.total} app ${noun} can name an owner (${report.stamped} to stamp, ${report.alreadyOwned} already marked)`
    : `${owned} of ${report.total} app ${noun} name an owner (${report.stamped} stamped, ${report.alreadyOwned} already marked)`;

  const tail: string[] = [];
  if (report.exempt > 0) tail.push(`${report.exempt} exempt`);
  if (report.gaps.length > 0) tail.push(`${report.gaps.length} unresolved`);
  return tail.length > 0 ? `${head}; ${tail.join(", ")}` : head;
}

/** Names to print before collapsing the rest into a count. */
const MAX_NAMED = 10;

function nameList(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return names.length > MAX_NAMED ? `${shown} and ${names.length - MAX_NAMED} more` : shown;
}

/** What a person has to do to close each kind of gap. */
function remedy(reason: AppDirOwnerGapReason): string {
  switch (reason) {
    case "orphaned":
      return "no app in the database claims them; delete the directory or recreate the app";
    case "ambiguous":
      return "rename the duplicate apps so one app owns each directory";
    case "unreadable":
      return `repair or delete the malformed ${APP_OWNER_FILE} or ${APP_OWNERS_DIR} record`;
    case "unwritable":
      return `${APP_OWNERS_DIR} is not writable by uid ${APP_UID}; run chown -R ${APP_UID}:${APP_UID} ${APP_OWNERS_DIR}`;
    case "failed":
      return "see GET /api/v1/admin/maintenance/app-dir-owners for the error on each";
  }
}

/** One line per reason, naming the directories and what would resolve them. */
export function describeAppDirOwnerGaps(report: AppDirOwnerReport): string[] {
  const byReason = new Map<AppDirOwnerGapReason, string[]>();
  for (const gap of report.gaps) {
    const names = byReason.get(gap.reason) ?? [];
    names.push(gap.appName);
    byReason.set(gap.reason, names);
  }
  return [...byReason].map(
    ([reason, names]) => `${names.length} ${reason}: ${nameList(names)} — ${remedy(reason)}`,
  );
}

/**
 * Startup pass. Idempotent and near-free once complete — unclaimed directories
 * are the only ones that reach the database.
 */
export async function stampAppDirOwnersAtStartup(): Promise<void> {
  const report = await stampAllAppDirOwners();
  if (report.total === 0) return;

  log.info(summarizeAppDirOwners(report));
  if (report.pruned > 0) log.info(`Pruned ${report.pruned} record(s) for directories that are gone`);
  for (const line of describeAppDirOwnerGaps(report)) log.warn(line);

  if (report.unmirrored.length > 0) {
    log.info(
      `${report.unmirrored.length} app directories are owned via ${APP_OWNERS_DIR} but carry no ${APP_OWNER_FILE} ` +
        `because uid ${APP_UID} cannot write them: ${nameList(report.unmirrored)}. ` +
        `Ownership is enforced either way; a non-recursive chown ${APP_UID}:${APP_UID} on each would let it carry its own marker.`,
    );
  }
}
