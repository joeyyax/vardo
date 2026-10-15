// Which volume sources the backup engine can capture. Shared with the backups UI.

import { exclusionReason, isBackupSelected, type Durability } from "./durability";

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

/** How a backup row's log says the engine skipped a bind source that's empty and never held data. */
export const EMPTY_BIND_SKIP_LOG = "is empty and has never been backed up with data";

export type VolumeCoverage = { covered: true } | { covered: false; reason: string | null };

/**
 * Whether a nightly run backs up this volume. Not covered with a null reason holds nothing to list.
 * `appReason`: null when a run takes the app, undefined when the app is gone.
 */
export async function volumeCoverage(
  vol: CoverableVolume & { persistent: boolean; durability: Durability | null; backupSelection: "include" | "exclude" | null },
  opts: { direct: boolean; appReason: string | null | undefined; configReason: () => Promise<string | null> },
): Promise<VolumeCoverage> {
  const excluded = exclusionReason(vol.durability);
  if (excluded) return { covered: false, reason: excluded };
  if (opts.direct) return { covered: true };
  if (opts.appReason === undefined) return { covered: false, reason: null };
  if (!isBackupSelected(vol)) return { covered: false, reason: vol.backupSelection === "exclude" ? "Switched off for this volume" : null };
  if (opts.appReason) return { covered: false, reason: opts.appReason };
  if (isUncapturedSource(vol)) return { covered: false, reason: "Bind mount, not opted in" };
  const config = await opts.configReason();
  return config ? { covered: false, reason: config } : { covered: true };
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
