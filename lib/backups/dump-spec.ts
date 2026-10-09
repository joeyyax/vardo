// Database dump specs: engine and compose service, resolved to a container at run time.
// Container names carry the slot, so never store them. Credentials come from the container's env.

import type { DatabaseKind } from "./durability";

export type DumpSpec = {
  kind: DatabaseKind;
  /** Compose service name. Stable across slots, unlike the container name. */
  service: string;
};

/** Container environment, as `KEY=value` lines from a container inspect. */
export type ContainerEnv = string[];

export function readEnv(env: ContainerEnv, key: string): string | null {
  const prefix = `${key}=`;
  for (const line of env) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/** Constant shell fragments. Never interpolate caller data; credentials stay off the host process list. */
const MYSQL_DUMP =
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -u root --single-transaction --routines --events --all-databases';
const MYSQL_RESTORE = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root';
// MariaDB 11 images ship only mariadb-* clients; older ones and Percona only mysql*.
const MARIADB_PWD = 'export MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"';
const MARIADB_DUMP =
  `${MARIADB_PWD}; c=$(command -v mariadb-dump || command -v mysqldump); ` +
  'exec "$c" -u root --single-transaction --routines --events --all-databases';
const MARIADB_RESTORE = `${MARIADB_PWD}; c=$(command -v mariadb || command -v mysql); exec "$c" -u root`;
const MONGO_DUMP =
  'exec mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const MONGO_RESTORE =
  'exec mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';

/** Marker directory inside an Uptime Kuma archive. */
export const KUMA_DUMP_DIR = "vardo-kuma-dump";

// Uptime Kuma: a tar of /app/data with the live database swapped for a consistent copy.
// `type` records which database the copy came from: embedded-mariadb, sqlite or none.
const KUMA_SOCKET = "/app/data/run/mariadb.sock";
const KUMA_DUMP = [
  "set -e",
  "cd /app/data",
  't=$(mktemp -d)',
  "trap 'rm -rf \"$t\"' EXIT",
  `k="$t/${KUMA_DUMP_DIR}"`,
  'mkdir "$k"',
  'y=$(sed -n \'s/.*"type"[^"]*"\\([^"]*\\)".*/\\1/p\' db-config.json 2>/dev/null || true)',
  'case "$y" in',
  `  embedded-mariadb) mariadb-dump --socket=${KUMA_SOCKET} -u "$(id -un)" --single-transaction --routines --events --add-drop-database --databases kuma > "$k/kuma.sql" ;;`,
  '  sqlite) [ -f kuma.db ] || { echo "kuma.db is missing" >&2; exit 1; }; sqlite3 kuma.db ".timeout 30000" ".backup \'$k/kuma.sqlite\'" ;;',
  '  "") y=none ;;',
  '  *) echo "Uptime Kuma uses an external $y database; back that database up instead" >&2; exit 1 ;;',
  "esac",
  'printf "%s\\n" "$y" > "$k/type"',
  "tar -cf - --exclude=./mariadb --exclude=./run --exclude=./kuma.db --exclude=./kuma.db-wal --exclude=./kuma.db-shm " +
    `--exclude=./error.log --exclude='./.vardo-restore.*' . -C "$t" ${KUMA_DUMP_DIR}`,
].join("\n");
const KUMA_RESTORE = [
  "set -e",
  "cd /app/data",
  't=$(mktemp -d /app/data/.vardo-restore.XXXXXX)',
  "trap 'rm -rf \"$t\"' EXIT",
  'tar -xf - -C "$t"',
  `k="$t/${KUMA_DUMP_DIR}"`,
  '[ -f "$k/type" ] || { echo "Not an Uptime Kuma archive from Vardo" >&2; exit 1; }',
  'case "$(cat "$k/type")" in',
  `  embedded-mariadb) mariadb --socket=${KUMA_SOCKET} -u "$(id -un)" < "$k/kuma.sql" ;;`,
  '  sqlite) sqlite3 kuma.db ".timeout 30000" ".restore \'$k/kuma.sqlite\'" ;;',
  "  none) ;;",
  '  *) echo "Unknown Uptime Kuma database type" >&2; exit 1 ;;',
  "esac",
  'rm -rf "$k"',
  'cp -a "$t/." /app/data/',
].join("\n");

/** Postgres user and database, from the image's own conventions. */
function postgresTarget(env: ContainerEnv): { user: string; database: string } {
  const user = readEnv(env, "POSTGRES_USER") || "postgres";
  return { user, database: readEnv(env, "POSTGRES_DB") || user };
}

/** `docker exec` arguments that write a dump to stdout. `--clean --if-exists` restores over a populated database. */
export function buildDumpArgv(
  kind: DatabaseKind,
  containerId: string,
  env: ContainerEnv,
): string[] {
  switch (kind) {
    case "postgres": {
      const { user, database } = postgresTarget(env);
      return ["exec", containerId, "pg_dump", "-U", user, "--clean", "--if-exists", database];
    }
    case "mysql":
      return ["exec", containerId, "sh", "-c", MYSQL_DUMP];
    case "mariadb":
      return ["exec", containerId, "sh", "-c", MARIADB_DUMP];
    case "uptime-kuma":
      return ["exec", containerId, "sh", "-c", KUMA_DUMP];
    case "mongo":
      return ["exec", containerId, "sh", "-c", MONGO_DUMP];
  }
}

/**
 * `docker exec` arguments that read a dump from stdin.
 * Keep `ON_ERROR_STOP=1`: without it psql reports success after skipping failed statements.
 */
export function buildRestoreArgv(
  kind: DatabaseKind,
  containerId: string,
  env: ContainerEnv,
  /** Database to restore into. MySQL and MariaDB dumps with `USE` statements still switch. */
  database?: string,
): string[] {
  // Passed as a positional parameter, never spliced into the script.
  const dbArgs = database ? ["sh", database] : [];
  const withDb = (script: string) => (database ? `${script} "$1"` : script);
  switch (kind) {
    case "postgres": {
      const target = postgresTarget(env);
      return [
        "exec", "-i", containerId,
        "psql", "-U", target.user, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", database || target.database,
      ];
    }
    case "mysql":
      return ["exec", "-i", containerId, "sh", "-c", withDb(MYSQL_RESTORE), ...dbArgs];
    case "mariadb":
      return ["exec", "-i", containerId, "sh", "-c", withDb(MARIADB_RESTORE), ...dbArgs];
    case "uptime-kuma":
      return ["exec", "-i", containerId, "sh", "-c", KUMA_RESTORE];
    case "mongo":
      return ["exec", "-i", containerId, "sh", "-c", MONGO_RESTORE];
  }
}

/**
 * `docker exec` arguments that load a `pg_dump -Fc` archive from stdin.
 * One transaction, as with psql. Owners and grants restore as dumped.
 */
export function buildPgRestoreArgv(containerId: string, env: ContainerEnv, database?: string): string[] {
  const target = postgresTarget(env);
  return [
    "exec", "-i", containerId,
    "pg_restore", "-U", target.user, "-d", database || target.database,
    "--clean", "--if-exists", "--single-transaction", "--exit-on-error",
  ];
}

/** Database the image created on first start, from its env. Null when it made none. */
export function defaultDatabase(kind: DatabaseKind, env: ContainerEnv): string | null {
  if (kind === "postgres") return postgresTarget(env).database;
  if (kind === "mysql" || kind === "mariadb") {
    return readEnv(env, "MARIADB_DATABASE") || readEnv(env, "MYSQL_DATABASE") || null;
  }
  return null;
}

/** Human-readable description of what a spec will run, for logs and the UI. */
export function describeDumpSpec(spec: DumpSpec): string {
  const tool = {
    postgres: "pg_dump",
    mysql: "mysqldump",
    mariadb: "mariadb-dump",
    mongo: "mongodump",
    "uptime-kuma": "Uptime Kuma database copy",
  }[spec.kind];
  return `${tool} against the "${spec.service}" service`;
}
