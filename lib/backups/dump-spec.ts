// ---------------------------------------------------------------------------
// Database dump specs
//
// A dump command cannot be stored, because it has to name a container and app
// container names carry the blue/green slot:
//
//     paperless-production-blue-paperless-db-1
//
// One deploy later that name is gone. What is stored instead is what the
// database *is* — engine and compose service, both stable across slots — and
// the container is resolved when the backup runs.
//
// Credentials are never stored either. They are already in the container's own
// environment, which is the copy that is always current.
//
// Pure — no server imports, so the UI can explain a spec without running one.
// ---------------------------------------------------------------------------

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

/**
 * Shell fragments below interpolate **no** caller data — every one is a
 * constant, and the credential is read from the container's own environment by
 * the shell inside it. That keeps secrets off the host process list, where a
 * `docker exec -e PASSWORD=…` would put them.
 */
const MYSQL_DUMP =
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -u root --single-transaction --all-databases';
const MYSQL_RESTORE = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -u root';
const MONGO_DUMP =
  'exec mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const MONGO_RESTORE =
  'exec mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';

/** Postgres user and database, from the image's own conventions. */
function postgresTarget(env: ContainerEnv): { user: string; database: string } {
  const user = readEnv(env, "POSTGRES_USER") || "postgres";
  return { user, database: readEnv(env, "POSTGRES_DB") || user };
}

/**
 * `docker exec` arguments that write a dump to stdout.
 *
 * Postgres connects over the local socket, which the official image trusts, so
 * no password changes hands. `--clean --if-exists` is what makes the result
 * restorable over a populated database rather than only into an empty one.
 */
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
    case "mariadb":
      return ["exec", containerId, "sh", "-c", MYSQL_DUMP];
    case "mongo":
      return ["exec", containerId, "sh", "-c", MONGO_DUMP];
  }
}

/**
 * `docker exec` arguments that read a dump from stdin.
 *
 * `ON_ERROR_STOP=1` is the half that makes a failed restore *fail*. Without it
 * psql reports success after skipping every statement it could not apply.
 */
export function buildRestoreArgv(
  kind: DatabaseKind,
  containerId: string,
  env: ContainerEnv,
): string[] {
  switch (kind) {
    case "postgres": {
      const { user, database } = postgresTarget(env);
      return ["exec", "-i", containerId, "psql", "-U", user, "-v", "ON_ERROR_STOP=1", "-d", database];
    }
    case "mysql":
    case "mariadb":
      return ["exec", "-i", containerId, "sh", "-c", MYSQL_RESTORE];
    case "mongo":
      return ["exec", "-i", containerId, "sh", "-c", MONGO_RESTORE];
  }
}

/** Human-readable description of what a spec will run, for logs and the UI. */
export function describeDumpSpec(spec: DumpSpec): string {
  const tool = {
    postgres: "pg_dump",
    mysql: "mysqldump",
    mariadb: "mysqldump",
    mongo: "mongodump",
  }[spec.kind];
  return `${tool} against the "${spec.service}" service`;
}
