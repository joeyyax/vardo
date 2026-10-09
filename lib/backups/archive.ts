// Shell scripts that write and read a volume's tar.gz. No server imports: the UI shares the threshold.

/** Minimum size of a non-empty tar.gz. Waived only on a confirmed-empty source. */
export const MIN_VALID_GZIP_BYTES = 100;

/** Printed by the backup script when the source directory held nothing. */
export const EMPTY_SOURCE_MARKER = "vardo:empty-source";

/** Written by the backup script, inside the backup dir: what tar left out. */
export const EXCLUDE_LIST_FILE = "exclude.list";

/** Written by the streaming backup script, inside the backup dir: markers, since stdout carries the archive. */
export const MARKERS_FILE = "markers";

/** Read by the restore script, inside the backup dir: what to carry over. */
export const PROTECT_LIST_FILE = "protect.list";

const RESTORE_STAGE_DIR = ".vardo-restore-staging";

/** Shell script that copies a volume aside as a tar.gz, as the pre-restore snapshot. */
export function buildTarBackupScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `cd "${dataDir}"`,
    'if [ "$#" -gt 0 ]; then',
    `  find . "$@" > "${backupDir}/${EXCLUDE_LIST_FILE}"`,
    `  tar czf "${backupDir}/volume.tar.gz" -X "${backupDir}/${EXCLUDE_LIST_FILE}" -C "${dataDir}" .`,
    "else",
    `  tar czf "${backupDir}/volume.tar.gz" -C "${dataDir}" .`,
    "fi",
    `if [ -z "$(ls -A "${dataDir}")" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
  ].join("\n");
}

/**
 * Shell script for a tar backup: stream the tar.gz to stdout, then record whether the source was empty.
 * Exclusions arrive as `find` argv. Never interpolate operator patterns into this string.
 */
export function buildTarStreamScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `cd "${dataDir}"`,
    'if [ "$#" -gt 0 ]; then',
    `  find . "$@" > "${backupDir}/${EXCLUDE_LIST_FILE}"`,
    `  tar czf - -X "${backupDir}/${EXCLUDE_LIST_FILE}" -C "${dataDir}" .`,
    "else",
    `  tar czf - -C "${dataDir}" .`,
    "fi",
    `if [ -z "$(ls -A "${dataDir}")" ]; then echo "${EMPTY_SOURCE_MARKER}" > "${backupDir}/${MARKERS_FILE}"; fi`,
  ].join("\n");
}

/** Stream a single bind-mounted file's tar.gz to stdout. Mounted at `${dataDir}/${FILE_PAYLOAD_NAME}`. */
export function buildFileStreamScript(dataDir = "/data"): string {
  return ["set -e", `tar czf - -C "${dataDir}" ${FILE_PAYLOAD_NAME}`].join("\n");
}

/** Printed when the mounted source is a directory. Its absence is the signal. */
export const DIRECTORY_SOURCE_MARKER = "vardo:source-is-directory";

/** Printed when the mounted source is a regular file. */
export const FILE_SOURCE_MARKER = "vardo:source-is-file";

/** Fixed mount name for a single-file bind source, so no host path reaches a shell script. */
export const FILE_PAYLOAD_NAME = "payload";

/** Copy a single bind-mounted file aside as a tar.gz, as the pre-restore snapshot. */
export function buildFileBackupScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `tar czf "${backupDir}/volume.tar.gz" -C "${dataDir}" ${FILE_PAYLOAD_NAME}`,
  ].join("\n");
}

/**
 * Restore a single bind-mounted file, writing through it after extraction.
 * `mv` over a bind mount point fails with EBUSY.
 */
export function buildFileRestoreScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    'stage="/tmp/vardo-restore"',
    'rm -rf "$stage"',
    'mkdir -p "$stage"',
    `if ! tar xzf "${backupDir}/volume.tar.gz" -C "$stage"; then echo "restore: archive could not be extracted" >&2; exit 1; fi`,
    `if [ ! -f "$stage/${FILE_PAYLOAD_NAME}" ]; then echo "restore: archive does not hold a single file" >&2; exit 1; fi`,
    `cat "$stage/${FILE_PAYLOAD_NAME}" > "${dataDir}/${FILE_PAYLOAD_NAME}"`,
    'rm -rf "$stage"',
  ].join("\n");
}

/**
 * Preflight for a bind source, run inside the container since `-v` resolves on the host.
 * Docker creates a missing source as an empty directory, so emptiness is reported.
 */
export function buildBindPreflightScript(dataDir = "/data"): string {
  return [
    "set -e",
    `if [ -d "${dataDir}" ]; then echo "${DIRECTORY_SOURCE_MARKER}"; fi`,
    `if [ -f "${dataDir}" ]; then echo "${FILE_SOURCE_MARKER}"; fi`,
    `if [ -d "${dataDir}" ] && [ -z "$(ls -A "${dataDir}" 2>/dev/null)" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
    `if [ -f "${dataDir}" ] && [ ! -s "${dataDir}" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
  ].join("\n");
}

/**
 * Shell script for a tar restore: extract to staging, carry over `protect.list` paths, then swap.
 * Keep the removal of live data after the extract, or a bad archive empties the volume.
 */
export function buildTarRestoreScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `data="${dataDir}"`,
    `stage="$data/${RESTORE_STAGE_DIR}"`,
    `protect="${backupDir}/${PROTECT_LIST_FILE}"`,
    'rm -rf "$stage"',
    'mkdir "$stage"',
    `if ! tar xzf "${backupDir}/volume.tar.gz" -C "$stage"; then rm -rf "$stage"; echo "restore: archive could not be extracted" >&2; exit 1; fi`,
    'if [ -f "$protect" ]; then',
    "  while IFS= read -r p; do",
    '    [ -n "$p" ] || continue',
    `    case "$p" in /*|.|..|./*|../*|*/../*|*/..|${RESTORE_STAGE_DIR}|${RESTORE_STAGE_DIR}/*) echo "restore: refusing protected path $p" >&2; exit 1 ;; esac`,
    '    [ -e "$data/$p" ] || continue',
    '    mkdir -p "$stage/$(dirname "$p")"',
    '    rm -rf "$stage/$p"',
    '    mv "$data/$p" "$stage/$p"',
    '  done < "$protect"',
    "fi",
    `find "$data" -mindepth 1 -maxdepth 1 ! -name ${RESTORE_STAGE_DIR} -exec rm -rf {} ';'`,
    `find "$stage" -mindepth 1 -maxdepth 1 -exec mv {} "$data/" ';'`,
    'rmdir "$stage"',
  ].join("\n");
}
