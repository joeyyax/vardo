// ---------------------------------------------------------------------------
// Log level detection.
//
// Container output rarely follows one convention, so detection covers the
// formats a fleet actually emits: nginx, redis, postgres, mysql, Python
// tracebacks, JSON logs and Vardo's own [stage] deploy markers.
// ---------------------------------------------------------------------------

export type LogLevel = "error" | "warn" | "info" | "debug" | "other";

/** Every level, in chip order. */
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "other"];

const ERROR_RE = /\b(ERROR|FATAL|PANIC|CRIT(ICAL)?|EMERG(ENCY)?|ALERT|SEVERE|FAILED|FAILURE|TRACEBACK)\b|[A-Za-z]*(Error|Exception)\b/i;
const WARN_RE = /\bWARN(ING)?\b|[A-Za-z]warning\b|\bDEPRECAT(ED|ION)\b|\[compat\]/i;
const INFO_RE = /\b(INFO|NOTICE|NOTE|SYSTEM)\b|\bLOG:|\[(deploy|health|docker)\]/i;
const DEBUG_RE = /\b(DEBUG\d?|TRACE|VERBOSE)\b/i;

/** Wrapped or indented output belongs to the line above it. */
const CONTINUATION_RE = /^\s|^\.{3}/;

/** Postgres severity keywords that elaborate on the preceding line. */
const PG_DETAIL_RE = /\b(DETAIL|HINT|STATEMENT|CONTEXT|QUERY):/;

/** Redis prefixes its message with a level char: `1:M 02 Aug 2026 10:00:00.000 * msg`. */
const REDIS_RE = /^\d+:[A-Z]\s+\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+([.\-*#])\s/;

const REDIS_LEVELS: Record<string, LogLevel> = {
  ".": "debug",
  "-": "info",
  "*": "info",
  "#": "warn",
};

const HTTP_STATUS_RES = [
  // Combined access log: `"GET /path HTTP/1.1" 200 1234`
  /"[A-Z]+ [^"]*"\s+(\d{3})\b/,
  // Structured: `status=404`, `"status": 500`
  /\bstatus(?:_?code)?"?\s*[=:]\s*"?(\d{3})\b/i,
  // Bare request line: `GET /path 200`
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+(\d{3})\b/,
];

/** The HTTP status a line reports, or null when it isn't a request log. */
export function httpStatus(text: string): number | null {
  for (const re of HTTP_STATUS_RES) {
    const m = text.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Classify a single line. Pass `previous` so continuation lines — stack frames,
 * wrapped SQL, postgres DETAIL — keep the level of the line they belong to.
 */
export function detectLevel(text: string, previous?: LogLevel): LogLevel {
  if (previous && (CONTINUATION_RE.test(text) || PG_DETAIL_RE.test(text))) return previous;

  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warn";

  const redis = text.match(REDIS_RE);
  if (redis) return REDIS_LEVELS[redis[1]];

  if (DEBUG_RE.test(text)) return "debug";
  if (INFO_RE.test(text)) return "info";

  const status = httpStatus(text);
  if (status !== null) {
    if (status >= 500) return "error";
    if (status >= 400) return "warn";
    return "info";
  }

  return "other";
}

/** Classify a batch, threading each line's level into the next. */
export function assignLevels(texts: string[]): LogLevel[] {
  let previous: LogLevel | undefined;
  return texts.map((text) => {
    previous = detectLevel(text, previous);
    return previous;
  });
}

export type LeveledLine = { text: string; level?: LogLevel };

export function countLevels(lines: LeveledLine[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  for (const line of lines) counts[line.level ?? detectLevel(line.text)]++;
  return counts;
}

/** An empty selection means no filter, not nothing selected. */
export function filterByLevel<T extends LeveledLine>(lines: T[], active: ReadonlySet<LogLevel>): T[] {
  if (active.size === 0) return lines;
  return lines.filter((line) => active.has(line.level ?? detectLevel(line.text)));
}
