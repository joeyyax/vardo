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

import { readdir } from "fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  PROJECTS_DIR,
  appBaseDir,
  appNameFromPath,
  appOwnerFile,
  readAppDirOwner,
  writeAppDirOwner,
} from "@/lib/paths";
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
 * - marker matches → allowed
 * - marker names another app, or cannot be read → refused
 * - no directory → allowed, nothing to destroy
 * - directory with no marker → adopted only when exactly one app in the
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
        `Refusing to ${operation} "${appName}": ${dir} is owned by app ${owner.appId}, not ${appId}. ` +
          `Rename this app so it gets its own directory.`,
        appId,
        appName,
      );

    case "missing":
      return;

    case "unreadable":
      throw new AppDirOwnershipError(
        `Refusing to ${operation} "${appName}": ${appOwnerFile(appName)} could not be read (${owner.reason}). ` +
          `Fix the marker before retrying — an unreadable marker is not an absent one.`,
        appId,
        appName,
      );

    case "unmarked": {
      const ids = await claimants(appName);
      if (ids.length !== 1 || ids[0] !== appId) {
        throw new AppDirOwnershipError(
          `Refusing to ${operation} "${appName}": ${dir} predates ownership markers and ${ids.length} apps claim the name. ` +
            `Rename the duplicates so one app owns the directory.`,
          appId,
          appName,
        );
      }
      // Uniqueness is the authorization; the stamp is bookkeeping.
      try {
        await writeAppDirOwner(appName, appId);
      } catch (err) {
        log.warn(`Could not stamp ownership marker for ${appName}:`, err);
      }
      return;
    }
  }
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
// Stamps every app directory and reports coverage. Adoption resolves a name
// against the database, so it only works while top-level names are unique.
// ---------------------------------------------------------------------------

/** Why a directory could not be given an owner. Each needs a hand to resolve. */
export type AppDirOwnerGapReason =
  /** Marker present but unparseable. */
  | "unreadable"
  /** No app in the database claims the name — an orphaned directory on disk. */
  | "orphaned"
  /** More than one app claims the name. */
  | "ambiguous"
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
  /** Markers written, or writable when `dryRun`. */
  stamped: number;
  /** Directories that already named an owner. */
  alreadyOwned: number;
  /** Vardo's own directory, whose marker can never be authoritative. */
  exempt: number;
  /** Directories left without an owner, each named with its reason. */
  gaps: AppDirOwnerGap[];
  dryRun: boolean;
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Stamp every unmarked app directory with the app that claims its name.
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

      if (!dryRun) await writeAppDirOwner(appName, ids[0]);
      report.stamped++;
    } catch (err) {
      gap("failed", errText(err));
    }
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

/**
 * Startup pass. Idempotent and near-free once complete — unmarked directories
 * are the only ones that reach the database.
 */
export async function stampAppDirOwnersAtStartup(): Promise<void> {
  const report = await stampAllAppDirOwners();
  if (report.total === 0) return;

  log.info(summarizeAppDirOwners(report));
  if (report.gaps.length > 0) {
    log.warn(
      `Unowned app directories: ${report.gaps.map((g) => `${g.appName} (${g.reason})`).join(", ")}`,
    );
  }
}
