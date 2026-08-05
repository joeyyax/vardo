// ---------------------------------------------------------------------------
// Archive shape
//
// The shell that produces and consumes a volume's tar.gz, plus the facts needed
// to judge one valid. No server imports, so the UI can read the same threshold.
// ---------------------------------------------------------------------------

/**
 * A tar.gz holding at least one file clears this comfortably; busybox tar emits
 * 87 bytes for an empty directory. Only ever waived on a confirmed-empty source.
 */
export const MIN_VALID_GZIP_BYTES = 100;

/** Printed by the backup script when the source directory held nothing. */
export const EMPTY_SOURCE_MARKER = "vardo:empty-source";

const RESTORE_STAGE_DIR = ".vardo-restore-staging";

/**
 * Shell script for a tar backup: archive the volume, then report whether the
 * source was empty. Size alone cannot separate an empty volume from a truncated
 * archive, so this marker is what the size guard consults.
 *
 * Paths are parameterized so tests can drive the real script against temp dirs.
 */
export function buildTarBackupScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `tar czf "${backupDir}/volume.tar.gz" -C "${dataDir}" .`,
    `if [ -z "$(ls -A "${dataDir}")" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
  ].join("\n");
}

/** Printed when the mounted source is a directory. Its absence is the signal. */
export const DIRECTORY_SOURCE_MARKER = "vardo:source-is-directory";

/**
 * Preflight for a bind source, run inside the one-shot container.
 *
 * It has to run here rather than in Node: Vardo speaks to the daemon over a
 * socket while `-v` is interpreted against the *host* filesystem, so an
 * `fs.stat` from this process inspects the wrong machine and answers
 * confidently about nothing.
 *
 * Docker creates a missing bind source as an empty root-owned directory rather
 * than failing, so "exists" is not evidence the path was right — emptiness is
 * reported and the caller decides.
 */
export function buildBindPreflightScript(dataDir = "/data"): string {
  return [
    "set -e",
    `if [ -d "${dataDir}" ]; then echo "${DIRECTORY_SOURCE_MARKER}"; fi`,
    `if [ -z "$(ls -A "${dataDir}" 2>/dev/null)" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
  ].join("\n");
}

/**
 * Shell script for a tar restore: extract into a staging dir inside the volume,
 * and only swap it over the live data once tar has fully succeeded.
 *
 * WARNING: the removal of live data must stay after the extract. Moving it
 * earlier (or back to a plain `rm -rf /data/*` before `tar xzf`) empties the
 * volume whenever the archive is unreadable or the wrong format.
 *
 * Paths are parameterized so tests can drive the real script against temp dirs.
 */
export function buildTarRestoreScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `stage="${dataDir}/${RESTORE_STAGE_DIR}"`,
    'rm -rf "$stage"',
    'mkdir "$stage"',
    `if ! tar xzf "${backupDir}/volume.tar.gz" -C "$stage"; then rm -rf "$stage"; echo "restore: archive could not be extracted" >&2; exit 1; fi`,
    `find "${dataDir}" -mindepth 1 -maxdepth 1 ! -name ${RESTORE_STAGE_DIR} -exec rm -rf {} ';'`,
    `find "$stage" -mindepth 1 -maxdepth 1 -exec mv {} "${dataDir}/" ';'`,
    'rmdir "$stage"',
  ].join("\n");
}
