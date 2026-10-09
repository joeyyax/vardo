// Database dump specs: engine and compose service, resolved to a container at run time.
// Container names carry the slot, so never store them. Credentials come from the container's env.

import { proposeDurability, type DatabaseKind } from "./durability";

export type DumpSpec = {
  kind: DatabaseKind;
  /** Compose service name. Stable across slots, unlike the container name. */
  service: string;
};

/** Spec for a mount now served by a different service or engine. Null when current or the mount is no database. */
export function refreshDumpSpec(
  current: DumpSpec | null,
  mount: { image: string; mountPath: string; volumeName: string; service: string },
): DumpSpec | null {
  if (!current || !mount.service) return null;
  const kind = proposeDurability({
    image: mount.image,
    mountPath: mount.mountPath,
    volumeName: mount.volumeName,
  })?.kind;
  if (!kind) return null;
  if (current.service === mount.service && current.kind === kind) return null;
  return { kind, service: mount.service };
}

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

// pg_restore renders SQL into psql after `$3`, all in one transaction. $1 user, $2 database, $3 SQL run first.
// A failed pg_restore never sends its COMMIT, so psql's transaction rolls back.
const PG_ARCHIVE_RESTORE = [
  'f=$(mktemp)',
  '{ printf "%s\\n" "$3"; pg_restore --clean --if-exists --single-transaction -f - || echo failed > "$f"; } ' +
    '| psql -X -q -v ON_ERROR_STOP=1 -U "$1" -d "$2" > /dev/null',
  's=$?',
  '[ -s "$f" ] && s=1',
  'rm -f "$f"',
  'exit $s',
].join("\n");

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQL that opens the restore's transaction and drops inheritance and partition trees in `schemas`.
 * `--clean` drops a partition's constraints before its parent's, which Postgres rejects.
 */
export function buildPgRestorePrelude(schemas: string[]): string {
  // pg_restore's own BEGIN follows; this keeps its "already in a transaction" warning out of the log.
  const lines = ["SET client_min_messages = error;", "BEGIN;", "SET LOCAL lock_timeout = '30s';"];
  if (!schemas.length) return lines.join("\n");
  lines.push(
    "DO $vardo$ DECLARE t text; BEGIN",
    "FOR t IN SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace",
    `WHERE n.nspname = ANY (ARRAY[${schemas.map(sqlLiteral).join(", ")}]::text[]) AND c.relkind IN ('r', 'p')`,
    "AND EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid)",
    "AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)",
    "LOOP EXECUTE 'DROP TABLE IF EXISTS ' || t || ' CASCADE'; END LOOP; END $vardo$;",
  );
  return lines.join("\n");
}

/**
 * `docker exec` arguments that load a `pg_dump -Fc` archive from stdin over a populated database.
 * One transaction, as with psql. Owners and grants restore as dumped.
 */
export function buildPgRestoreArgv(
  containerId: string,
  env: ContainerEnv,
  database?: string,
  /** Schemas the archive writes, from `createMissingDumpRoles`. */
  schemas: string[] = [],
): string[] {
  const target = postgresTarget(env);
  return [
    "exec", "-i", containerId,
    "sh", "-c", PG_ARCHIVE_RESTORE, "sh", target.user, database || target.database, buildPgRestorePrelude(schemas),
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
