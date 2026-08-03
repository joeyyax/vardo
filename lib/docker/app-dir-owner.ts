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

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
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
