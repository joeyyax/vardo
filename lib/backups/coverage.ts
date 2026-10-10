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

/** Why a row a deploy marked removed is skipped. */
export function removedVolumeReason(vol: { name: string; mountPath: string | null }, removedAt: Date): string {
  const at = vol.mountPath ? ` at ${vol.mountPath}` : "";
  return `No longer declared by the app — ${vol.name}${at} left its compose on ${removedAt.toISOString().slice(0, 10)}`;
}

/**
 * Why a named volume with no Docker volume behind it is skipped, from the running containers' mounts.
 * Null when the app still mounts a volume there or nothing is running to tell.
 */
export function undeclaredVolumeReason(
  vol: { name: string; mountPath: string | null },
  mounts: { destination: string; type: string; source: string }[] | null,
): string | null {
  if (!mounts || !vol.mountPath) return null;
  const at = mounts.find((m) => m.destination === vol.mountPath);
  if (at && at.type !== "bind") return null;
  const now = at ? `${vol.mountPath} is now a bind mount of ${at.source}` : `nothing mounts ${vol.mountPath}`;
  return `No longer declared by the app — ${now}. Redeploy to update its volume records`;
}
