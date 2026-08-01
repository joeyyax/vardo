// ---------------------------------------------------------------------------
// Images whose on-disk format is tied to the tag's major version.
//
// Postgres refuses to start against a data directory written by a different
// major — outline's `postgres:16` → `18` update failed exactly this way. For
// these images a major bump is a migration, not an update, so it is never
// offered as the default candidate.
// ---------------------------------------------------------------------------

const MAJOR_LOCKED =
  /^(?:.*\/)?(postgres|postgis|timescaledb?|pgvector|mysql|mariadb|percona|mongo|influxdb|elasticsearch|opensearch)\b/i;

/** Whether a major bump of this image requires migrating its data directory. */
export function isMajorLocked(image: string): boolean {
  const repo = image.split("@")[0].replace(/:[^:/]*$/, "");
  return MAJOR_LOCKED.test(repo);
}
