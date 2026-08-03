// ---------------------------------------------------------------------------
// Loki HTTP client — queries persistent container logs
//
// Loki runs with auth_enabled, so a tenant is one organization and every read
// names the organization it is asking for. A read with no organization throws.
// ---------------------------------------------------------------------------

function lokiUrl(): string {
  return process.env.LOKI_URL || "http://loki:3100";
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

const TENANT_HEADER = "X-Scope-OrgID";

/**
 * Tenant holding logs from containers with no owning organization. Contains a
 * dot, which the organization id alphabet does not, so no organization can
 * ever address it.
 */
export const UNASSIGNED_TENANT = "vardo.unassigned";

/** The tenant a read is scoped to. Throws rather than letting a blank one read every tenant. */
export function requireTenant(organizationId: string): string {
  const tenant = organizationId?.trim();
  if (!tenant) throw new Error("Loki read requires an organization id");
  return tenant;
}

/** Header naming the organization whose logs a request covers. */
export function tenantHeaders(organizationId: string): Record<string, string> {
  return { [TENANT_HEADER]: requireTenant(organizationId) };
}

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
    const res = await fetch(`${lokiUrl()}/ready`, { signal: AbortSignal.timeout(2000) });
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
  /** Organization whose logs this covers. */
  organizationId: string;
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
  const headers = tenantHeaders(opts.organizationId);
  const params = new URLSearchParams({
    query: opts.query,
    limit: String(opts.limit ?? 500),
    direction: opts.direction ?? "backward",
  });

  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);

  const res = await fetch(`${lokiUrl()}/loki/api/v1/query_range?${params}`, {
    headers,
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
// Instant metric queries
// ---------------------------------------------------------------------------

export type LokiVectorEntry = { labels: Record<string, string>; value: number };

type LokiVectorResponse = {
  data: { result: { metric: Record<string, string>; value: [number, string] }[] };
};

/** Run a LogQL metric query at a single instant. One call covers one organization. */
export async function queryInstant(
  query: string,
  organizationId: string,
): Promise<LokiVectorEntry[]> {
  const headers = tenantHeaders(organizationId);
  const params = new URLSearchParams({ query });

  const res = await fetch(`${lokiUrl()}/loki/api/v1/query?${params}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Loki query failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as LokiVectorResponse;
  return (body.data?.result ?? []).map((r) => ({
    labels: r.metric,
    value: parseFloat(r.value[1]),
  }));
}

// ---------------------------------------------------------------------------
// Tail (WebSocket) — streams new entries via Loki's /tail endpoint
// ---------------------------------------------------------------------------

export type TailOptions = {
  query: string;
  /** Organization whose logs this covers. */
  organizationId: string;
  /** Seconds to wait for late-arriving logs (default 2) */
  delayFor?: number;
  start?: string;
};

/** Undici's WebSocket takes request headers; the DOM type it is declared as does not. */
type WebSocketWithHeaders = new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

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
  const headers = tenantHeaders(opts.organizationId);
  const wsUrl = lokiUrl().replace(/^http/, "ws");
  const params = new URLSearchParams({
    query: opts.query,
    delay_for: String(opts.delayFor ?? 2),
  });
  if (opts.start) params.set("start", opts.start);

  return new Promise<void>((resolve) => {
    const ws = new (WebSocket as unknown as WebSocketWithHeaders)(
      `${wsUrl}/loki/api/v1/tail?${params}`,
      { headers },
    );

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
