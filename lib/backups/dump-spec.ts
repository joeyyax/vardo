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
    case "mariadb":
      return ["exec", containerId, "sh", "-c", MYSQL_DUMP];
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
): string[] {
  switch (kind) {
    case "postgres": {
      const { user, database } = postgresTarget(env);
      return [
        "exec", "-i", containerId,
        "psql", "-U", user, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", database,
      ];
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
