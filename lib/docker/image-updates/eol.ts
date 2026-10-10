// End-of-life dates for common stateful engines. Static data, no network fetch.
// Dates cross-checked against https://endoflife.date; each engine names its upstream policy page.

export interface EolSeries {
  /** Release series as the tag starts: `16`, `8.0`, `10.11`. */
  series: string;
  /** Last day of upstream security fixes, `YYYY-MM-DD`. */
  eol: string;
}

export interface EolEngine {
  id: string;
  /** Name shown to people. */
  label: string;
  /** Tested against the repository's last path segment. */
  match: RegExp;
  source: string;
  series: EolSeries[];
}

/** Warn this many days before a series ends. */
export const EOL_WARN_DAYS = 90;

export const EOL_TABLE: EolEngine[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    match: /^(postgres|postgresql|postgis)$/i,
    // https://www.postgresql.org/support/versioning/
    source: "https://www.postgresql.org/support/versioning/",
    series: [
      { series: "9.5", eol: "2021-02-11" },
      { series: "9.6", eol: "2021-11-11" },
      { series: "10", eol: "2022-11-10" },
      { series: "11", eol: "2023-11-09" },
      { series: "12", eol: "2024-11-21" },
      { series: "13", eol: "2025-11-13" },
      { series: "14", eol: "2026-11-12" },
      { series: "15", eol: "2027-11-11" },
      { series: "16", eol: "2028-11-09" },
      { series: "17", eol: "2029-11-08" },
      { series: "18", eol: "2030-11-14" },
    ],
  },
  {
    id: "mysql",
    label: "MySQL",
    match: /^mysql$/i,
    // https://www.mysql.com/support/eol-notice.html
    source: "https://www.mysql.com/support/eol-notice.html",
    series: [
      { series: "5.6", eol: "2021-02-28" },
      { series: "5.7", eol: "2023-10-31" },
      { series: "8.0", eol: "2026-04-30" },
      { series: "8.4", eol: "2032-04-30" },
    ],
  },
  {
    id: "mariadb",
    label: "MariaDB",
    match: /^mariadb$/i,
    // https://mariadb.org/about/#maintenance-policy
    source: "https://mariadb.org/about/#maintenance-policy",
    series: [
      { series: "10.3", eol: "2023-05-25" },
      { series: "10.4", eol: "2024-06-18" },
      { series: "10.5", eol: "2025-06-24" },
      { series: "10.6", eol: "2026-07-06" },
      { series: "10.11", eol: "2028-02-16" },
      { series: "11.4", eol: "2029-05-29" },
      { series: "11.8", eol: "2028-06-04" },
    ],
  },
  {
    id: "mongo",
    label: "MongoDB",
    match: /^(mongo|mongodb)$/i,
    // https://www.mongodb.com/legal/support-policy/lifecycles
    source: "https://www.mongodb.com/legal/support-policy/lifecycles",
    // Docker's bare-major tags (`mongo:7`) track the X.0 release.
    series: [
      { series: "4.4", eol: "2024-02-29" },
      { series: "4", eol: "2024-02-29" },
      { series: "5.0", eol: "2024-10-31" },
      { series: "5", eol: "2024-10-31" },
      { series: "6.0", eol: "2025-07-31" },
      { series: "6", eol: "2025-07-31" },
      { series: "7.0", eol: "2027-08-31" },
      { series: "7", eol: "2027-08-31" },
      { series: "8.0", eol: "2029-10-31" },
    ],
  },
  {
    id: "redis",
    label: "Redis",
    match: /^redis$/i,
    // https://redis.io/about/releases/
    source: "https://redis.io/about/releases/",
    series: [
      { series: "6.0", eol: "2022-05-31" },
      { series: "6.2", eol: "2027-04-01" },
      { series: "7.0", eol: "2024-07-29" },
      { series: "7.2", eol: "2029-12-01" },
      { series: "7.4", eol: "2029-12-01" },
      { series: "8.0", eol: "2026-12-01" },
    ],
  },
  {
    id: "valkey",
    label: "Valkey",
    match: /^valkey$/i,
    // https://valkey.io/topics/releases/
    source: "https://valkey.io/topics/releases/",
    series: [
      { series: "7.2", eol: "2029-04-16" },
      { series: "8.0", eol: "2027-09-15" },
      { series: "8.1", eol: "2030-03-31" },
      { series: "9.0", eol: "2028-10-21" },
    ],
  },
  {
    id: "elasticsearch",
    label: "Elasticsearch",
    match: /^elasticsearch$/i,
    // https://www.elastic.co/support/eol
    source: "https://www.elastic.co/support/eol",
    series: [
      { series: "6", eol: "2022-02-10" },
      { series: "7", eol: "2026-01-15" },
      { series: "8.17", eol: "2025-08-12" },
      { series: "8.18", eol: "2025-10-21" },
      { series: "8.19", eol: "2027-07-15" },
    ],
  },
  {
    id: "opensearch",
    label: "OpenSearch",
    match: /^opensearch$/i,
    // https://opensearch.org/releases/
    source: "https://opensearch.org/releases/",
    series: [{ series: "1", eol: "2025-05-06" }],
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    match: /^rabbitmq$/i,
    // https://www.rabbitmq.com/release-information
    source: "https://www.rabbitmq.com/release-information",
    series: [
      { series: "3.12", eol: "2024-02-21" },
      { series: "3.13", eol: "2024-09-17" },
      { series: "4.0", eol: "2025-04-15" },
      { series: "4.1", eol: "2026-01-30" },
      { series: "4.2", eol: "2026-07-31" },
    ],
  },
];

/** Overrides replace a series by name and add new engines; the base table is untouched. */
export function mergeEolTables(base: EolEngine[], overrides: EolEngine[]): EolEngine[] {
  const merged = base.map((engine) => ({ ...engine, series: [...engine.series] }));
  for (const extra of overrides) {
    const existing = merged.find((engine) => engine.id === extra.id);
    if (!existing) {
      merged.push({ ...extra, series: [...extra.series] });
      continue;
    }
    for (const entry of extra.series) {
      const at = existing.series.findIndex((s) => s.series === entry.series);
      if (at === -1) existing.series.push(entry);
      else existing.series[at] = entry;
    }
  }
  return merged;
}

function lastSegment(image: string): string {
  const repo = image.split("@")[0].replace(/:[^:/]*$/, "");
  return repo.split("/").pop() ?? repo;
}

function releaseOf(tag: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(tag);
  return match ? match[1].split(".").map(Number) : null;
}

export interface EolMatch {
  engine: string;
  label: string;
  series: string;
  eol: string;
  source: string;
}

/** The release series a tag runs, by longest prefix. Null for unknown engines and floating tags. */
export function findEol(image: string, tag: string, table: EolEngine[] = EOL_TABLE): EolMatch | null {
  const engine = table.find((e) => e.match.test(lastSegment(image)));
  if (!engine) return null;
  const release = releaseOf(tag);
  if (!release) return null;

  let best: EolSeries | null = null;
  let bestLength = 0;
  for (const entry of engine.series) {
    const parts = entry.series.split(".").map(Number);
    if (parts.length > release.length || parts.length <= bestLength) continue;
    if (parts.every((part, i) => part === release[i])) {
      best = entry;
      bestLength = parts.length;
    }
  }
  if (!best) return null;
  return { engine: engine.id, label: engine.label, series: best.series, eol: best.eol, source: engine.source };
}

export interface EolNotice extends EolMatch {
  /** `ended` once past the date; `ending` inside the warning window. */
  state: "ended" | "ending";
  daysLeft: number;
}

/** A notice when the running series is past or near end of life, else null. */
export function eolNotice(
  image: string,
  tag: string,
  now: number = Date.now(),
  { table = EOL_TABLE, warnDays = EOL_WARN_DAYS }: { table?: EolEngine[]; warnDays?: number } = {},
): EolNotice | null {
  const match = findEol(image, tag, table);
  if (!match) return null;
  const end = Date.parse(`${match.eol}T23:59:59Z`);
  if (Number.isNaN(end)) return null;
  const daysLeft = Math.ceil((end - now) / 86_400_000);
  if (daysLeft > warnDays) return null;
  return { ...match, state: daysLeft <= 0 ? "ended" : "ending", daysLeft };
}

/** Plain sentence for a notice, e.g. "PostgreSQL 13 stopped getting security fixes on Nov 13, 2025." */
export function describeEol(notice: EolNotice): string {
  const date = new Date(`${notice.eol}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const name = `${notice.label} ${notice.series}`;
  return notice.state === "ended"
    ? `${name} stopped getting security fixes on ${date}.`
    : `${name} stops getting security fixes on ${date}.`;
}
