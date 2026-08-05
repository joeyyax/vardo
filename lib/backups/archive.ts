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

/**
 * Printed when the archive holds at least one non-directory member.
 *
 * The size floor cannot stand in for this once exclusions exist: a pattern
 * matching every file still leaves the directory tree, which clears 100 bytes.
 */
export const ARCHIVE_HAS_FILES_MARKER = "vardo:archive-has-files";

/** Written by the backup script, inside the backup dir: what tar left out. */
export const EXCLUDE_LIST_FILE = "exclude.list";

/** Read by the restore script, inside the backup dir: what to carry over. */
export const PROTECT_LIST_FILE = "protect.list";

const RESTORE_STAGE_DIR = ".vardo-restore-staging";

/**
 * Shell script for a tar backup: archive the volume, then report whether the
 * source was empty. Size alone cannot separate an empty volume from a truncated
 * archive, so this marker is what the size guard consults.
 *
 * Exclusions arrive as positional arguments — `find` predicates built by
 * `buildFindExclusionArgv`. Operator patterns are never interpolated into this
 * string, and tar only ever sees the literal paths `find` resolved them to.
 *
 * Paths are parameterized so tests can drive the real script against temp dirs.
 */
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
    `if tar tzf "${backupDir}/volume.tar.gz" | grep -qv '/$'; then echo "${ARCHIVE_HAS_FILES_MARKER}"; fi`,
  ].join("\n");
}

/** Printed when the mounted source is a directory. Its absence is the signal. */
export const DIRECTORY_SOURCE_MARKER = "vardo:source-is-directory";

/** Printed when the mounted source is a regular file. */
export const FILE_SOURCE_MARKER = "vardo:source-is-file";

/**
 * Where a single-file bind source is mounted inside the helper container.
 *
 * Fixed rather than the real basename, so the archive round-trips without the
 * name having to survive in the storage key, and so nothing derived from a
 * host path is ever interpolated into a shell script.
 */
export const FILE_PAYLOAD_NAME = "payload";

/** Archive a single bind-mounted file. Mounted at `${dataDir}/${FILE_PAYLOAD_NAME}`. */
export function buildFileBackupScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `tar czf "${backupDir}/volume.tar.gz" -C "${dataDir}" ${FILE_PAYLOAD_NAME}`,
  ].join("\n");
}

/**
 * Restore a single bind-mounted file.
 *
 * The contents are written through the existing file rather than replacing it:
 * the path is a bind mount point, so `mv` over it fails with EBUSY. Extraction
 * happens first, so a bad archive leaves the original untouched.
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
    `if [ -f "${dataDir}" ]; then echo "${FILE_SOURCE_MARKER}"; fi`,
    `if [ -d "${dataDir}" ] && [ -z "$(ls -A "${dataDir}" 2>/dev/null)" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
    `if [ -f "${dataDir}" ] && [ ! -s "${dataDir}" ]; then echo "${EMPTY_SOURCE_MARKER}"; fi`,
  ].join("\n");
}

/**
 * Shell script for a tar restore: extract into a staging dir inside the volume,
 * and only swap it over the live data once tar has fully succeeded.
 *
 * The contract is that restore replaces the archived portion and leaves the
 * paths the archive deliberately omitted as it found them. `protect.list` names
 * those paths; each is moved from the live copy into the staging tree before
 * the swap, so they survive it. Same filesystem, so the move is a rename, and a
 * failure part-way through leaves the volume intact because the clear has not
 * run yet.
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
