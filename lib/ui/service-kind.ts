import { SERVICE_KINDS, type ServiceKind } from "@/lib/db/schema/enums";

export { SERVICE_KINDS, type ServiceKind };

export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  database: "Database",
  cache: "Cache",
  worker: "Worker",
  web: "Web",
  other: "Other",
};

/** Kinds that nest under the app depending on them. */
export const NESTED_KINDS: ReadonlySet<ServiceKind> = new Set(["database", "cache", "worker"]);

// Matched against the image's repository name, without registry or tag.
const DATABASE = /(^|[-_/])(postgres|postgis|pgvector|vchord-postgres|timescaledb|mysql|mariadb|mongo|mongodb|meilisearch|elasticsearch|opensearch|clickhouse|cockroach|couchdb|influxdb|neo4j|cassandra|scylla|surrealdb|questdb|typesense|qdrant|weaviate|chromadb?)([-_]|$)/;
const CACHE = /(^|[-_/])(redis|redis-stack|redis-stack-server|valkey|keydb|dragonfly|memcached)([-_]|$)/;
const WORKER = /(^|[-_/])(worker|workers|sidekiq|celery|queue|jobs?|scheduler|cron|tika|gotenberg|buildkit)([-_]|$)/;

/** The repository part of an image reference: `ghcr.io/acme/api:1.2` is `acme/api`. */
export function imageRepository(image: string): string {
  let ref = image.trim().toLowerCase().split("@")[0];
  const parts = ref.split("/");
  if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
  ref = parts.join("/");
  const colon = ref.lastIndexOf(":");
  return colon > ref.lastIndexOf("/") ? ref.slice(0, colon) : ref;
}

/** Image name first, then the service name for images built from source. */
export function inferServiceKind(input: {
  image?: string | null;
  serviceName?: string | null;
  hasPort?: boolean;
}): ServiceKind {
  const candidates = [input.image ? imageRepository(input.image) : null, input.serviceName?.toLowerCase() ?? null];
  for (const name of candidates) {
    if (!name) continue;
    if (DATABASE.test(name)) return "database";
    if (CACHE.test(name)) return "cache";
    if (WORKER.test(name)) return "worker";
  }
  return input.hasPort ? "web" : "other";
}

/** The user's choice, else what the last deploy inferred, else inferred now for apps not yet redeployed. */
export function effectiveKind(app: {
  kind?: ServiceKind | null;
  kindOverride?: ServiceKind | null;
  imageName?: string | null;
  composeService?: string | null;
  name?: string;
}): ServiceKind {
  return (
    app.kindOverride ??
    app.kind ??
    inferServiceKind({ image: app.imageName, serviceName: app.composeService ?? app.name })
  );
}

export function isServiceKind(value: unknown): value is ServiceKind {
  return typeof value === "string" && (SERVICE_KINDS as readonly string[]).includes(value);
}
