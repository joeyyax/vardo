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
};

/**
 * True when the engine cannot capture this source.
 *
 * A bind mount is capturable two ways: a dump replaces the archive step
 * entirely, or the volume is explicitly `stateful`, which is what opts a host
 * path into being tarred. Anything else stays uncaptured — bind mounts are
 * where the multi-terabyte media libraries live, so this is opt-in and stays
 * opt-in.
 */
export function isUncapturedSource(vol: CoverableVolume): boolean {
  if (vol.type !== "bind") return false;
  if (vol.backupStrategy === "dump") return false;
  return vol.durability !== "stateful";
}

/** Operator-facing reason a source was skipped. */
export function uncapturedReason(vol: CoverableVolume): string {
  const path = vol.source ? ` (${vol.source})` : "";
  return `Bind mount${path} is not backed up — mark the volume stateful to archive this host path`;
}
