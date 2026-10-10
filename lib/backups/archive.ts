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

/** Written by the backup scripts, inside the backup dir: tar's messages for files that vanished or changed mid-read. */
export const VANISHED_LIST_FILE = "vanished.list";

const VANISHED_MESSAGE = "(No such file or directory|file changed as we read it|file removed before we read it)";

// Busybox tar has no --ignore-failed-read: it skips a file gone between listing and reading, then exits 1.
const TOLERATED_TAR_ERRORS = [
  `: ${VANISHED_MESSAGE}$`,
  "error exit delayed from previous errors",
  "Exiting with failure status due to previous errors",
].join("|");

/**
 * Lists exclusions and runs tar into `out`. Exit 1 passes when every message is about a file that vanished or
 * changed mid-read; anything else fails the script with the tool's own output.
 */
function tarTolerantOfVanishedFiles(out: string, dataDir: string, backupDir: string): string[] {
  const err = `"${backupDir}/tar.err"`;
  return [
    "tolerate_vanished() {",
    '  [ "$1" -eq 0 ] && return 0',
    `  if [ "$1" -eq 1 ] && [ -s ${err} ] && ! grep -q "can't execute" ${err} && ! grep -qvE '${TOLERATED_TAR_ERRORS}' ${err}; then`,
    `    grep -E ': ${VANISHED_MESSAGE}$' ${err} >> "${backupDir}/${VANISHED_LIST_FILE}" || true`,
    "    return 0",
    "  fi",
    `  cat ${err} >&2`,
    '  exit "$1"',
    "}",
    "rc=0",
    'if [ "$#" -gt 0 ]; then',
    `  find . "$@" > "${backupDir}/${EXCLUDE_LIST_FILE}" 2> ${err} || rc=$?`,
    '  tolerate_vanished "$rc"',
    "  rc=0",
    `  tar czf ${out} -X "${backupDir}/${EXCLUDE_LIST_FILE}" -C "${dataDir}" . 2> ${err} || rc=$?`,
    "else",
    `  tar czf ${out} -C "${dataDir}" . 2> ${err} || rc=$?`,
    "fi",
    'tolerate_vanished "$rc"',
    `rm -f ${err}`,
  ];
}

const VANISHED_LINE = new RegExp(
  `^[^:]*: (?:can't open '(.+)'|(.+?)(?:: Cannot \\w+)?): ${VANISHED_MESSAGE}$`,
);

/** Paths in a VANISHED_LIST_FILE, relative to the volume root. */
export function parseVanishedPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const line of body.split("\n")) {
    const m = VANISHED_LINE.exec(line.trim());
    const path = m?.[1] ?? m?.[2];
    if (path) paths.add(path.replace(/^\.\//, ""));
  }
  return [...paths];
}

/** Shell script that copies a volume aside as a tar.gz, as the pre-restore snapshot. */
export function buildTarBackupScript(dataDir = "/data", backupDir = "/backup"): string {
  return [
    "set -e",
    `cd "${dataDir}"`,
    ...tarTolerantOfVanishedFiles(`"${backupDir}/volume.tar.gz"`, dataDir, backupDir),
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
    ...tarTolerantOfVanishedFiles("-", dataDir, backupDir),
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
 * The archive's `.` entry sets the volume root's owner and mode.
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
    `if ! tar xzf "${backupDir}/volume.tar.gz" -C "$stage" -p; then rm -rf "$stage"; echo "restore: archive could not be extracted" >&2; exit 1; fi`,
    `if tar tzf "${backupDir}/volume.tar.gz" | grep -qxE '\\./?'; then`,
    `  meta="$(stat -c '%u:%g %a' "$stage" 2>/dev/null || stat -f '%u:%g %Lp' "$stage")"`,
    '  chown "${meta% *}" "$data" 2>/dev/null || true',
    '  chmod "${meta#* }" "$data"',
    "fi",
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
