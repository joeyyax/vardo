// VictoriaLogs HTTP client. Every read carries its organization's AccountID; a read with no organization throws before any request.

import { accountHeaders, logAccountId } from "./account";
import { redactLine } from "./redact";

export function victoriaLogsUrl(): string {
  return (process.env.VICTORIALOGS_URL || "http://victorialogs:9428").replace(/\/+$/, "");
}

export type LogEntry = {
  timestamp: string; // nanosecond unix timestamp
  line: string;
  labels: Record<string, string>;
};

/** Log fields the viewer and counters filter on, as the shipper writes them. */
export const FIELD = {
  project: "vardo.project",
  projectId: "vardo.project.id",
  environment: "vardo.environment",
  service: "compose_service",
} as const;

let ready: boolean | null = null;
let lastCheck = 0;

/** Check if VictoriaLogs is reachable. Cached for 30s. */
export async function isVictoriaLogsAvailable(): Promise<boolean> {
  const now = Date.now();
  if (ready !== null && now - lastCheck < 30_000) return ready;
  try {
    const res = await fetch(`${victoriaLogsUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    ready = res.ok;
  } catch {
    ready = false;
  }
  lastCheck = now;
  return ready;
}

// LogsQL

/** A double-quoted LogsQL string. LogsQL unquotes with Go's rules, which accept JSON's escapes. */
export function logsQLString(value: string): string {
  return JSON.stringify(value);
}

/** Escapes regex metacharacters so a search term matches literally. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type LogFilter = {
  project: string;
  environment?: string;
  service?: string;
  /** Case-insensitive substring of the line. */
  search?: string;
};

/** `{project: "shop", search: "err"}` → `"vardo.project":="shop" _msg:~"(?i)err"` */
export function buildLogsQLQuery(filter: LogFilter): string {
  const parts = [`"${FIELD.project}":=${logsQLString(filter.project)}`];
  if (filter.environment) parts.push(`"${FIELD.environment}":=${logsQLString(filter.environment)}`);
  if (filter.service) parts.push(`${FIELD.service}:=${logsQLString(filter.service)}`);
  if (filter.search) parts.push(`_msg:~${logsQLString(`(?i)${regexLiteral(filter.search)}`)}`);
  return parts.join(" ");
}

// Requests

type Params = Record<string, string | string[] | undefined>;

function form(params: Params): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) body.append(k, item);
  }
  return body;
}

async function select(path: string, organizationId: string, params: Params, signal: AbortSignal): Promise<Response> {
  const headers = accountHeaders(await logAccountId(organizationId));
  const res = await fetch(`${victoriaLogsUrl()}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: form(params),
    signal,
  });
  if (!res.ok) throw new Error(`VictoriaLogs ${path} failed (${res.status}): ${(await res.text()).trim()}`);
  return res;
}

function iso(t: Date | string | undefined): string | undefined {
  return t instanceof Date ? t.toISOString() : t;
}

/** RFC3339 with up to nine fractional digits → nanoseconds since the epoch. */
export function nanos(time: string): string {
  const m = /^(.+?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(time);
  const ms = m ? Date.parse(`${m[1]}${m[3]}`) : NaN;
  if (!m || Number.isNaN(ms)) return "0";
  const frac = (m[2] ?? "").slice(0, 9).padEnd(9, "0");
  return (BigInt(ms) * BigInt(1_000_000) + BigInt(frac)).toString();
}

const INTERNAL = new Set(["_msg", "_time", "_stream", "_stream_id"]);

function toEntry(row: Record<string, unknown>): LogEntry {
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!INTERNAL.has(k) && v != null) labels[k] = String(v);
  }
  return { timestamp: nanos(String(row._time ?? "")), line: redactLine(String(row._msg ?? "")), labels };
}

function parseLines(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(toEntry(JSON.parse(raw)));
    } catch {
      // skip a malformed line
    }
  }
  return out;
}

const byTime = (a: LogEntry, b: LogEntry) =>
  a.timestamp.padStart(20, "0").localeCompare(b.timestamp.padStart(20, "0"));

export type QueryOptions = {
  query: string;
  /** Organization whose logs this covers. */
  organizationId: string;
  start?: Date | string;
  end?: Date | string;
  /** The most recent N matches. */
  limit?: number;
};

/** The newest `limit` matching lines, oldest first. */
export async function queryLogs(opts: QueryOptions): Promise<LogEntry[]> {
  const res = await select(
    "/select/logsql/query",
    opts.organizationId,
    { query: opts.query, limit: String(opts.limit ?? 500), start: iso(opts.start), end: iso(opts.end) },
    AbortSignal.timeout(10_000),
  );
  return parseLines(await res.text()).sort(byTime);
}

export type TailOptions = {
  query: string;
  organizationId: string;
  /** Drop lines at or before this nanosecond timestamp, which a backfill already sent. */
  after?: string;
};

/** Streams new lines from /select/logsql/tail until the signal aborts or the server closes. */
export async function tailLogs(opts: TailOptions, onEntry: (entry: LogEntry) => void, signal: AbortSignal): Promise<void> {
  // Outside the try, so a missing organization isn't swallowed.
  await logAccountId(opts.organizationId);
  const after = opts.after ? BigInt(opts.after) : null;
  let res: Response;
  try {
    res = await select("/select/logsql/tail", opts.organizationId, { query: opts.query }, signal);
  } catch {
    return;
  }
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const cut = buffer.lastIndexOf("\n");
      if (cut === -1) continue;
      const complete = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      for (const entry of parseLines(complete)) {
        if (after !== null && BigInt(entry.timestamp) <= after) continue;
        onEntry(entry);
      }
    }
  } catch {
    // aborted or dropped
  } finally {
    reader.releaseLock();
  }
}

export type HitSeries = { fields: Record<string, string>; timestamps: string[]; values: number[]; total: number };

/** Matching line counts per `step`, grouped by `fields`. */
export async function queryHits(opts: {
  query: string;
  organizationId: string;
  start: Date | string;
  end?: Date | string;
  step: string;
  fields?: string[];
}): Promise<HitSeries[]> {
  const res = await select(
    "/select/logsql/hits",
    opts.organizationId,
    { query: opts.query, start: iso(opts.start), end: iso(opts.end), step: opts.step, field: opts.fields },
    AbortSignal.timeout(30_000),
  );
  return ((await res.json()) as { hits?: HitSeries[] }).hits ?? [];
}

/** Distinct values of `field` among matching lines, with their counts. */
export async function queryFieldValues(opts: {
  query: string;
  organizationId: string;
  field: string;
  start?: Date | string;
  end?: Date | string;
  limit?: number;
}): Promise<{ value: string; hits: number }[]> {
  const res = await select(
    "/select/logsql/field_values",
    opts.organizationId,
    { query: opts.query, field: opts.field, start: iso(opts.start), end: iso(opts.end), limit: opts.limit ? String(opts.limit) : undefined },
    AbortSignal.timeout(10_000),
  );
  return ((await res.json()) as { values?: { value: string; hits: number }[] }).values ?? [];
}

export type VectorEntry = { labels: Record<string, string>; value: number };

/** Runs a `| stats` query at one instant. One call covers one organization. */
export async function queryStats(query: string, organizationId: string, time?: Date): Promise<VectorEntry[]> {
  const res = await select("/select/logsql/stats_query", organizationId, { query, time: iso(time) }, AbortSignal.timeout(30_000));
  const body = (await res.json()) as { data?: { result?: { metric: Record<string, string>; value: [number, string] }[] } };
  return (body.data?.result ?? []).map((r) => {
    const { __name__: _, ...labels } = r.metric;
    return { labels, value: parseFloat(r.value[1]) };
  });
}
