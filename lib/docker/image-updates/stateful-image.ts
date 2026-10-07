// Images whose on-disk format is tied to the tag's major version. A major bump is a migration, never a default update.

// `pgvecto` covers pgvector and pgvecto-rs.
const MAJOR_LOCKED =
  /^(?:.*\/)?(postgres|postgis|timescaledb?|pgvecto(?:r|-rs)?|mysql|mariadb|percona|mongo|influxdb|elasticsearch|opensearch|neo4j|cassandra)\b/i;

/** Engines that own their data directory (two copies corrupt or lock it) without being tied to a major. */
const OWNS_DATA_DIRECTORY =
  /^(?:.*\/)?(redis|valkey|keydb|dragonfly|meilisearch|qdrant|typesense|clickhouse|couchdb|etcd|surrealdb|solr)\b/i;

/** Repository part of an image reference, with tag and digest removed. */
function imageRepo(image: string): string {
  return image.split("@")[0].replace(/:[^:/]*$/, "");
}

/** Whether a major bump of this image requires migrating its data directory. */
export function isMajorLocked(image: string): boolean {
  return MAJOR_LOCKED.test(imageRepo(image));
}

/** Whether two copies of this image on one directory would corrupt it. Broader than `isMajorLocked` (e.g. redis). */
export function ownsDataDirectory(image: string): boolean {
  const repo = imageRepo(image);
  return MAJOR_LOCKED.test(repo) || OWNS_DATA_DIRECTORY.test(repo);
}
