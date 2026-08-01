// ---------------------------------------------------------------------------
// What it takes to move a major-locked image across a major version.
//
// Two facts matter and neither is guessable from the tag: whether the engine
// can jump majors in one step, and what actually moves the data. Mongo and
// Elasticsearch refuse to start against a data directory more than one major
// behind, so "16 → 18" is two migrations for them and one for Postgres.
// ---------------------------------------------------------------------------

export type MigrationStrategy = "dump-restore" | "in-place-upgrade" | "reindex";

export interface MigrationPath {
  engine: string;
  strategy: MigrationStrategy;
  /** Majors crossable in one move. Beyond this, step through intermediates. */
  maxMajorJump: number;
  /** Ordered, runnable outline. `{from}`/`{to}` are the major versions. */
  steps: string[];
  docs: string;
}

const PATHS: { match: RegExp; path: Omit<MigrationPath, "engine"> }[] = [
  {
    match: /^(?:.*\/)?(postgres|postgis|pgvector|timescaledb?)\b/i,
    path: {
      strategy: "dump-restore",
      maxMajorJump: Infinity,
      steps: [
        "Back up the app — the restore below is the only way back.",
        "pg_dumpall -U $POSTGRES_USER > dump.sql (run against the {from} container)",
        "Stop the app and move the old data directory aside, do not delete it.",
        "Change the image tag to {to} and deploy — it initializes an empty data directory.",
        "psql -U $POSTGRES_USER -f dump.sql",
      ],
      docs: "https://www.postgresql.org/docs/current/upgrading.html",
    },
  },
  {
    match: /^(?:.*\/)?(mysql|percona)\b/i,
    path: {
      strategy: "in-place-upgrade",
      maxMajorJump: 1,
      steps: [
        "Back up the app.",
        "mysqldump --all-databases -u root -p > dump.sql",
        "Change the image tag to {to} and deploy — MySQL upgrades the data directory on first start.",
        "Watch the container log for 'upgrade' errors before trusting it.",
      ],
      docs: "https://dev.mysql.com/doc/refman/8.0/en/upgrading.html",
    },
  },
  {
    match: /^(?:.*\/)?mariadb\b/i,
    path: {
      strategy: "in-place-upgrade",
      maxMajorJump: 1,
      steps: [
        "Back up the app.",
        "mariadb-dump --all-databases -u root -p > dump.sql",
        "Change the image tag to {to} and deploy.",
        "mariadb-upgrade -u root -p",
      ],
      docs: "https://mariadb.com/kb/en/upgrading/",
    },
  },
  {
    match: /^(?:.*\/)?mongo\b/i,
    path: {
      strategy: "in-place-upgrade",
      maxMajorJump: 1,
      steps: [
        "Back up the app.",
        "Confirm the current featureCompatibilityVersion matches {from}.",
        "Change the image tag to {to} and deploy.",
        'db.adminCommand({setFeatureCompatibilityVersion: "{to}"}) once it is healthy.',
      ],
      docs: "https://www.mongodb.com/docs/manual/release-notes/",
    },
  },
  {
    match: /^(?:.*\/)?(elasticsearch|opensearch)\b/i,
    path: {
      strategy: "reindex",
      maxMajorJump: 1,
      steps: [
        "Back up the app — take a snapshot to a registered repository.",
        "Reindex any index created more than one major back.",
        "Change the image tag to {to} and deploy.",
      ],
      docs: "https://www.elastic.co/guide/en/elasticsearch/reference/current/setup-upgrade.html",
    },
  },
];

/** Leading integer of a tag: `16.2-alpine` → 16. Null when there isn't one. */
export function majorOf(tag: string): number | null {
  const match = tag.match(/^v?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** The migration recipe for an image, or null when it has no major lock. */
export function migrationPathFor(image: string): MigrationPath | null {
  const repo = image.split("@")[0].replace(/:[^:/]*$/, "");
  const entry = PATHS.find((p) => p.match.test(repo));
  if (!entry) return null;
  const engine = repo.split("/").pop() ?? repo;
  return { engine, ...entry.path };
}

export interface MigrationPlan extends MigrationPath {
  from: string;
  to: string;
  /** Majors to land on in order. Longer than one when the engine can't jump. */
  hops: number[];
  /** True when `to` is further than the engine can move in a single step. */
  needsIntermediateSteps: boolean;
}

/**
 * Turn a tag pair into a concrete plan, expanding the intermediate majors an
 * engine has to land on when it cannot jump straight there.
 */
export function planMigration(
  image: string,
  fromTag: string,
  toTag: string,
): MigrationPlan | null {
  const path = migrationPathFor(image);
  if (!path) return null;

  const from = majorOf(fromTag);
  const to = majorOf(toTag);
  if (from === null || to === null || to <= from) return null;

  const hops: number[] = [];
  if (Number.isFinite(path.maxMajorJump)) {
    for (let v = from + path.maxMajorJump; v < to; v += path.maxMajorJump) hops.push(v);
  }
  hops.push(to);

  return {
    ...path,
    from: fromTag,
    to: toTag,
    hops,
    needsIntermediateSteps: hops.length > 1,
    steps: path.steps.map((s) => s.replace(/\{from\}/g, String(from)).replace(/\{to\}/g, String(to))),
  };
}
