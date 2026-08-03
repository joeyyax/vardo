// ---------------------------------------------------------------------------
// Reading an engine's major version out of the image itself.
//
// A floating tag carries no version to compare, so `postgres:latest` rolling
// 17 → 18 is invisible to every tag-based check. The version is in the image:
// the official images export it as an env var, verified on the live host as
// PG_MAJOR=16/17/18 and MYSQL_MAJOR=8.0.
//
// Names are matched per engine rather than by a generic /MAJOR/ grep — the
// postgres image also carries GOSU_VERSION, which that would happily return.
// ---------------------------------------------------------------------------

import { isMajorLocked } from "./stateful-image";
import { majorOf } from "./migration-path";

/** Where a major came from, kept so an unknown can be told apart from a guess. */
export type MajorSource = "env" | "label";

export interface ImageMajor {
  major: number;
  source: MajorSource;
  /** The raw value read, for display. */
  raw: string;
}

const ENGINE_ENV: { match: RegExp; vars: string[] }[] = [
  { match: /^(?:.*\/)?(postgres|postgis|pgvector|timescaledb?)\b/i, vars: ["PG_MAJOR", "PG_VERSION"] },
  { match: /^(?:.*\/)?(mysql|percona)\b/i, vars: ["MYSQL_MAJOR", "MYSQL_VERSION"] },
  { match: /^(?:.*\/)?mariadb\b/i, vars: ["MARIADB_MAJOR", "MARIADB_VERSION"] },
  { match: /^(?:.*\/)?mongo\b/i, vars: ["MONGO_MAJOR", "MONGO_VERSION"] },
  { match: /^(?:.*\/)?influxdb\b/i, vars: ["INFLUXDB_VERSION", "INFLUX_VERSION"] },
  { match: /^(?:.*\/)?(elasticsearch|opensearch)\b/i, vars: ["ELASTIC_VERSION", "OPENSEARCH_VERSION"] },
];

/** Repository part of a ref, tag and digest stripped. */
function repoOf(image: string): string {
  return image.split("@")[0].replace(/:[^:/]*$/, "");
}

/** Env var names that carry this engine's version. Empty when not major-locked. */
export function majorEnvVars(image: string): string[] {
  return ENGINE_ENV.find((e) => e.match.test(repoOf(image)))?.vars ?? [];
}

function parseEnv(env: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq > 0) map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

/**
 * Major version of a major-locked engine image, or null when it cannot be read.
 *
 * Null means unknown and must never be treated as "unchanged" — an engine whose
 * version we cannot read is exactly the case where a silent bump would slip past.
 */
export function extractImageMajor(
  image: string,
  inspect: { env?: string[] | null; labels?: Record<string, string> | null },
): ImageMajor | null {
  if (!isMajorLocked(image)) return null;

  const vars = majorEnvVars(image);
  const env = parseEnv(inspect.env ?? []);
  for (const name of vars) {
    const raw = env.get(name);
    if (!raw) continue;
    const major = majorOf(raw);
    if (major !== null) return { major, source: "env", raw };
  }

  const label = inspect.labels?.["org.opencontainers.image.version"];
  const labelMajor = label ? majorOf(label) : null;
  if (labelMajor !== null && label) return { major: labelMajor, source: "label", raw: label };

  return null;
}

/**
 * Whether a re-pull would cross a major. Unknown on either side returns null,
 * which callers must treat as "cannot say", not as "no change".
 */
export function majorChanged(
  before: ImageMajor | null,
  after: ImageMajor | null,
): boolean | null {
  if (!before || !after) return null;
  return after.major !== before.major;
}
