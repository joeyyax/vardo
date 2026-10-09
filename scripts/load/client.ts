import { requestStats, type Outcome, type RequestStats } from "./stats";
import { DEFAULT_BACKOFF_MS, Pacer, isRateLimited, parseBackoffMs } from "./pacing";

export type Config = {
  url: string;
  token: string;
  tokens: string[];
  org: string | null;
  app: string | null;
  cookie: string | null;
};

export const REQUEST_TIMEOUT_MS = 30_000;

export function authHeaders(cfg: Config, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${cfg.token}`, ...extra };
}

function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "limited";
  return "error";
}

export type Probe = {
  id: string;
  label: string;
  path: string;
  headers?: Record<string, string>;
  /** Bearer tokens rotated round-robin per request, in addition to `headers`. */
  tokens?: string[];
};

/** One timed GET with the body drained. */
export async function timedGet(
  base: string,
  probe: Probe,
  n = 0,
): Promise<{ ms: number; outcome: Outcome; status: number; backoffMs: number | null }> {
  const start = performance.now();
  const tokens = probe.tokens;
  const headers = tokens?.length
    ? { ...probe.headers, authorization: `Bearer ${tokens[n % tokens.length]}` }
    : probe.headers;
  try {
    const res = await fetch(base + probe.path, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    const backoffMs = res.status === 429 ? parseBackoffMs((h) => res.headers.get(h)) : null;
    return { ms: performance.now() - start, outcome: classify(res.status), status: res.status, backoffMs };
  } catch {
    return { ms: performance.now() - start, outcome: "error", status: 0, backoffMs: null };
  }
}

export type LoadResult = RequestStats & {
  concurrency: number;
  statuses: Record<string, number>;
  /** Requests sent per minute, 429s included. */
  sentPerMin: number;
  /** Pacing target in requests per minute across all tokens; null when unpaced. */
  targetPerMin: number | null;
  rateLimited: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Closed loop: `concurrency` workers hit the probe for `seconds`, capped at `ratePerMin` per token when set. A 429 pauses the route. */
export async function runLoad(
  base: string,
  probe: Probe,
  concurrency: number,
  seconds: number,
  ratePerMin: number | null = null,
): Promise<LoadResult> {
  const samples: { ms: number; outcome: Outcome }[] = [];
  const statuses: Record<string, number> = {};
  const started = performance.now();
  const deadline = started + seconds * 1000;
  const targetPerMin = ratePerMin === null ? null : ratePerMin * (probe.tokens?.length || 1);
  const pacer = targetPerMin === null ? null : new Pacer(targetPerMin, started);
  let sent = 0;
  let pausedUntil = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const hold = pausedUntil - performance.now();
      if (hold > 0) {
        await sleep(Math.min(hold, Math.max(0, deadline - performance.now())));
        continue;
      }
      if (pacer) {
        const slot = pacer.reserve(performance.now());
        if (slot >= deadline) return;
        const wait = slot - performance.now();
        if (wait > 0) await sleep(wait);
      }
      const r = await timedGet(base, probe, sent++);
      samples.push({ ms: r.ms, outcome: r.outcome });
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.outcome === "limited") {
        const backoff = r.backoffMs ?? DEFAULT_BACKOFF_MS;
        pausedUntil = Math.max(pausedUntil, performance.now() + backoff);
        pacer?.penalize(pausedUntil);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = performance.now() - started;
  const stats = requestStats(samples, elapsed);
  return {
    ...stats,
    concurrency,
    statuses,
    sentPerMin: elapsed > 0 ? (stats.requests / elapsed) * 60_000 : 0,
    targetPerMin,
    rateLimited: isRateLimited(stats.requests, stats.limited),
  };
}

export async function getJson<T>(cfg: Config, path: string): Promise<T> {
  const res = await fetch(cfg.url + path, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/** JSON write that waits out a 429 (up to five times) so scratch setup and cleanup survive the mutation limit. */
export async function sendJson<T>(
  cfg: Config,
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(cfg.url + path, {
      method,
      headers: authHeaders(cfg, { "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 5) {
      await sleep(parseBackoffMs((h) => res.headers.get(h)) ?? 10_000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
