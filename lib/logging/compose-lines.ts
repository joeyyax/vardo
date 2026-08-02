// ---------------------------------------------------------------------------
// Parsing for `docker compose logs` output across several services at once.
// Compose emits `service-1  | 2026-08-02T03:02:54.218Z message` and groups the
// backfill per container, so lines have to be split apart and re-ordered.
// ---------------------------------------------------------------------------

export type ServiceLine = {
  text: string;
  service?: string;
  /** RFC3339 timestamp, present only when compose was asked for `--timestamps`. */
  timestamp?: string;
};

const PREFIX_RE = /^(\S+?)-\d+\s+\|\s?/;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.?\d*Z)\s/;

/** Split one compose output line into its service, timestamp and message. */
export function parseComposeLine(line: string): ServiceLine {
  const prefix = line.match(PREFIX_RE);
  if (!prefix) return { text: line };

  let text = line.slice(prefix[0].length);
  const stamp = text.match(TIMESTAMP_RE);
  if (stamp) text = text.slice(stamp[0].length);

  return { text, service: prefix[1], timestamp: stamp?.[1] };
}

/**
 * Order a batch by timestamp, keeping lines without one next to the line they
 * followed so stack traces stay intact.
 */
export function interleaveByTimestamp(lines: ServiceLine[]): ServiceLine[] {
  const groups: { key: string; lines: ServiceLine[] }[] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (line.timestamp || !last) {
      groups.push({ key: line.timestamp ?? "", lines: [line] });
    } else {
      last.lines.push(line);
    }
  }

  return groups
    .map((group, i) => ({ group, i }))
    .sort((a, b) => a.group.key.localeCompare(b.group.key) || a.i - b.i)
    .flatMap(({ group }) => group.lines);
}
