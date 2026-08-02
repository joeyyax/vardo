// ---------------------------------------------------------------------------
// Plain-text log search: match location, stepping and match-only filtering.
// ---------------------------------------------------------------------------

export type MatchRange = { start: number; end: number };

/** Non-overlapping, case-insensitive occurrences of `needle` in `haystack`. */
export function findRanges(haystack: string, needle: string): MatchRange[] {
  if (!needle) return [];
  const hay = haystack.toLowerCase();
  const term = needle.toLowerCase();
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const start = hay.indexOf(term, from);
    if (start === -1) break;
    ranges.push({ start, end: start + term.length });
    from = start + term.length;
  }
  return ranges;
}

export type LineMatch = {
  /** Index into the searched array. */
  line: number;
  /** Position of this match within its own line, starting at 0. */
  ordinal: number;
  start: number;
  end: number;
};

/** Every match across the buffer, in reading order. */
export function findMatches(texts: string[], query: string): LineMatch[] {
  if (!query) return [];
  const matches: LineMatch[] = [];
  texts.forEach((text, line) => {
    findRanges(text, query).forEach((range, ordinal) => {
      matches.push({ line, ordinal, ...range });
    });
  });
  return matches;
}

/** Move `delta` matches from `current`, wrapping at both ends. Returns -1 when there are none. */
export function stepMatch(current: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return ((from + delta) % total + total) % total;
}

/** Line indexes that contain at least one match. */
export function matchedLines(matches: LineMatch[]): Set<number> {
  return new Set(matches.map((m) => m.line));
}

/** Keep only lines containing a match. Losing context is the caller's choice, not the default. */
export function filterToMatches<T>(lines: T[], matched: ReadonlySet<number>): T[] {
  return lines.filter((_, i) => matched.has(i));
}
