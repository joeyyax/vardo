// Which volume sources the backup engine can capture. Shared with the backups UI.

export type CoverableVolume = {
  type: "named" | "bind";
  backupStrategy: string;
  source?: string | null;
  durability?: string | null;
  backupSelection?: string | null;
};

/** True when the engine can't capture this source. Bind mounts are opt-in: dump, `stateful` or selected. */
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

/** Why a dump can't be captured right now, or null. A dump needs a running container. */
export function pausedDumpReason(vol: {
  backupStrategy: string;
  /** apps.status for the owning app. Null for a volume linked without one. */
  appStatus?: string | null;
}): string | null {
  if (vol.backupStrategy !== "dump") return null;
  if (vol.appStatus !== "stopped") return null;
  return "App is stopped — a database dump needs a running container. Start the app to capture it.";
}
