// ---------------------------------------------------------------------------
// Which volume sources the backup engine can actually capture.
//
// Pure — shared by the engine (to skip) and the backups UI (to warn).
// ---------------------------------------------------------------------------

export type CoverableVolume = {
  type: "named" | "bind";
  backupStrategy: string;
  source?: string | null;
  durability?: string | null;
  backupSelection?: string | null;
};

/**
 * True when the engine cannot capture this source.
 *
 * A bind mount is capturable three ways: a dump replaces the archive step
 * entirely, the volume is explicitly `stateful`, or it was selected for backup
 * when its app was enrolled. Anything else stays uncaptured — bind mounts are
 * where the multi-terabyte media libraries live, so this is opt-in and stays
 * opt-in.
 */
export function isUncapturedSource(vol: CoverableVolume): boolean {
  if (vol.type !== "bind") return false;
  if (vol.backupStrategy === "dump") return false;
  if (vol.backupSelection === "include") return false;
  return vol.durability !== "stateful";
}

/** Operator-facing reason a source was skipped. */
export function uncapturedReason(vol: CoverableVolume): string {
  const path = vol.source ? ` (${vol.source})` : "";
  return `Bind mount${path} is not backed up — mark the volume stateful to archive this host path`;
}

/**
 * Why a dump cannot be captured right now, or null when it can.
 *
 * A dump runs inside the database, so it needs a container to run in. Tar does
 * not: a stopped app's volumes are still on disk and still archivable, which is
 * why only this one strategy pauses when the app comes down.
 */
export function pausedDumpReason(vol: {
  backupStrategy: string;
  /** apps.status for the owning app. Null for a volume linked without one. */
  appStatus?: string | null;
}): string | null {
  if (vol.backupStrategy !== "dump") return null;
  if (vol.appStatus !== "stopped") return null;
  return "App is stopped — a database dump needs a running container. Start the app to capture it.";
}
