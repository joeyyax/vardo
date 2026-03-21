// ---------------------------------------------------------------------------
// Loki HTTP client — queries persistent container logs
// ---------------------------------------------------------------------------

const LOKI_URL = process.env.LOKI_URL || "http://localhost:3100";

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

let lokiReady: boolean | null = null;
let lastCheck = 0;

/** Check if Loki is reachable. Cached for 30s. */
export async function isLokiAvailable(): Promise<boolean> {
  const now = Date.now();
  if (lokiReady !== null && now - lastCheck < 30_000) return lokiReady;
  try {
    const res = await fetch(`${LOKI_URL}/ready`, { signal: AbortSignal.timeout(2000) });
    lokiReady = res.ok;
  } catch {
    lokiReady = false;
  }
  lastCheck = now;
  return lokiReady;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogEntry = {
  timestamp: string; // nanosecond unix timestamp
  line: string;
  labels: Record<string, string>;
};

type LokiStream = {
  stream: Record<string, string>;
  values: [string, string][]; // [nanosecond timestamp, log line]
};

type LokiQueryResponse = {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
  };
};

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export type QueryRangeOptions = {
  query: string;
  start?: string; // RFC3339 or nanosecond timestamp
  end?: string;
  limit?: number;
  direction?: "forward" | "backward";
};

/**
 * Query historical logs from Loki.
 * Returns entries sorted by the requested direction.
 */
export async function queryRange(opts: QueryRangeOptions): Promise<LogEntry[]> {
  const params = new URLSearchParams({
    query: opts.query,
    limit: String(opts.limit ?? 500),
    direction: opts.direction ?? "backward",
  });

  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);

  const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loki query_range failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as LokiQueryResponse;
  return flattenStreams(body.data.result);
}

// ---------------------------------------------------------------------------
// Tail (WebSocket) — streams new entries via Loki's /tail endpoint
// ---------------------------------------------------------------------------

export type TailOptions = {
  query: string;
  /** Seconds to wait for late-arriving logs (default 2) */
  delayFor?: number;
  start?: string;
};

/**
 * Stream live logs from Loki via WebSocket.
 * Calls `onEntry` for each new log line.
 * Resolves when the AbortSignal fires.
 */
export async function tailLogs(
  opts: TailOptions,
  onEntry: (entry: LogEntry) => void,
  signal: AbortSignal,
): Promise<void> {
  const wsUrl = LOKI_URL.replace(/^http/, "ws");
  const params = new URLSearchParams({
    query: opts.query,
    delay_for: String(opts.delayFor ?? 2),
  });
  if (opts.start) params.set("start", opts.start);

  return new Promise<void>((resolve) => {
    const ws = new WebSocket(`${wsUrl}/loki/api/v1/tail?${params}`);

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { streams?: LokiStream[] };
        if (msg.streams) {
          for (const entry of flattenStreams(msg.streams)) {
            onEntry(entry);
          }
        }
      } catch {
        // skip malformed messages
      }
    });

    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* already closed */ }
      resolve();
    });

    signal.addEventListener("abort", () => {
      try { ws.close(); } catch { /* already closed */ }
      resolve();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// LogQL query builder
// ---------------------------------------------------------------------------

export type LogQueryOptions = {
  project: string;
  environment?: string;
  service?: string;
  search?: string;
};

/**
 * Build a LogQL query from structured options.
 *
 * Examples:
 *   {project: "myapp"} → {project="myapp"}
 *   {project: "myapp", search: "error"} → {project="myapp"} |~ `(?i)error`
 */
export function buildLogQLQuery(opts: LogQueryOptions): string {
  const selectors: string[] = [`project="${opts.project}"`];

  if (opts.environment) {
    selectors.push(`environment="${opts.environment}"`);
  }
  if (opts.service) {
    selectors.push(`service="${opts.service}"`);
  }

  let query = `{${selectors.join(", ")}}`;

  if (opts.search) {
    // Case-insensitive regex line filter
    const escaped = opts.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query += ` |~ \`(?i)${escaped}\``;
  }

  return query;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function flattenStreams(streams: LokiStream[]): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const stream of streams) {
    for (const [ts, line] of stream.values) {
      entries.push({
        timestamp: ts,
        line,
        labels: stream.stream,
      });
    }
  }

  return entries;
}
