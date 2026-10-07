// Loki HTTP client. Every read names its organization's tenant; a read with no organization throws.

function lokiUrl(): string {
  return process.env.LOKI_URL || "http://loki:3100";
}

const TENANT_HEADER = "X-Scope-OrgID";

/** Tenant for logs from containers with no organization. The dot keeps any organization id from addressing it. */
export const UNASSIGNED_TENANT = "vardo.unassigned";

/** The tenant a read is scoped to. Throws on a blank one, which would read every tenant. */
export function requireTenant(organizationId: string): string {
  const tenant = organizationId?.trim();
  if (!tenant) throw new Error("Loki read requires an organization id");
  return tenant;
}

/** Header naming the organization whose logs a request covers. */
export function tenantHeaders(organizationId: string): Record<string, string> {
  return { [TENANT_HEADER]: requireTenant(organizationId) };
}

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

export type QueryRangeOptions = {
  query: string;
  /** Organization whose logs this covers. */
  organizationId: string;
  start?: string; // RFC3339 or nanosecond timestamp
  end?: string;
  limit?: number;
  direction?: "forward" | "backward";
};

/** Query historical logs from Loki, sorted by the requested direction. */
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

export type TailOptions = {
  query: string;
  /** Organization whose logs this covers. */
  organizationId: string;
  /** Seconds to wait for late-arriving logs (default 2) */
  delayFor?: number;
  start?: string;
};

/** Undici's WebSocket takes request headers; its declared DOM type doesn't. */
type WebSocketWithHeaders = new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

/** Stream live logs from Loki's /tail WebSocket until the signal aborts. */
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

export type LogQueryOptions = {
  project: string;
  environment?: string;
  service?: string;
  search?: string;
};

/**
 * Build a LogQL query from structured options.
 * `{project: "myapp", search: "error"}` → {project="myapp"} |~ `(?i)error`
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
    const escaped = opts.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query += ` |~ \`(?i)${escaped}\``;
  }

  return query;
}

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
