// ---------------------------------------------------------------------------
// Which volume sources the backup engine can actually capture.
//
// Pure — shared by the engine (to skip) and the backups UI (to warn).
// ---------------------------------------------------------------------------

export type CoverableVolume = {
  type: "named" | "bind";
  backupStrategy: string;
  source?: string | null;
};

/**
 * True when the engine cannot capture this source. It archives named Docker
 * volumes; a bind mount only counts when a dump command replaces that step.
 */
export function isUncapturedSource(vol: CoverableVolume): boolean {
  return vol.type === "bind" && vol.backupStrategy !== "dump";
}

/** Operator-facing reason a source was skipped. */
export function uncapturedReason(vol: CoverableVolume): string {
  const path = vol.source ? ` (${vol.source})` : "";
  return `Bind mount${path} is not a named Docker volume — copy this host path yourself`;
}
