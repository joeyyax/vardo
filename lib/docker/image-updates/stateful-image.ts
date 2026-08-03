// ---------------------------------------------------------------------------
// Images whose on-disk format is tied to the tag's major version.
//
// Postgres refuses to start against a data directory written by a different
// major — outline's `postgres:16` → `18` update failed exactly this way. For
// these images a major bump is a migration, not an update, so it is never
// offered as the default candidate.
// ---------------------------------------------------------------------------

// `pgvecto` covers pgvector and pgvecto-rs, both Postgres distributions whose
// data directory is tied to the bundled PG major.
const MAJOR_LOCKED =
  /^(?:.*\/)?(postgres|postgis|timescaledb?|pgvecto(?:r|-rs)?|mysql|mariadb|percona|mongo|influxdb|elasticsearch|opensearch)\b/i;

/**
 * Engines that own their on-disk format without being tied to a major.
 * Redis rewrites its AOF on startup, so a second copy on one directory
 * corrupts it — but the format survives a version bump.
 */
const OWNS_DATA_DIRECTORY = /^(?:.*\/)?(redis|valkey|keydb|dragonfly)\b/i;

/** Repository part of an image reference, with tag and digest removed. */
function imageRepo(image: string): string {
  return image.split("@")[0].replace(/:[^:/]*$/, "");
}

/** Whether a major bump of this image requires migrating its data directory. */
export function isMajorLocked(image: string): boolean {
  return MAJOR_LOCKED.test(imageRepo(image));
}

/**
 * Whether two copies of this image on one directory would corrupt it.
 *
 * Deliberately not `isMajorLocked`. "Owns its on-disk format" and "may cross a
 * major unattended" answer different questions, and redis is the case where
 * they part: safe to update, unsafe to run twice.
 */
export function ownsDataDirectory(image: string): boolean {
  const repo = imageRepo(image);
  return MAJOR_LOCKED.test(repo) || OWNS_DATA_DIRECTORY.test(repo);
}
