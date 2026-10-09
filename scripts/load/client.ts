import { requestStats, type Outcome, type RequestStats } from "./stats";

export type Config = {
  url: string;
  token: string;
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
};

/** One timed GET with the body drained. */
export async function timedGet(
  base: string,
  probe: Probe,
): Promise<{ ms: number; outcome: Outcome; status: number }> {
  const start = performance.now();
  try {
    const res = await fetch(base + probe.path, {
      headers: probe.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - start, outcome: classify(res.status), status: res.status };
  } catch {
    return { ms: performance.now() - start, outcome: "error", status: 0 };
  }
}

export type LoadResult = RequestStats & { concurrency: number; statuses: Record<string, number> };

/** Closed loop: `concurrency` workers hit the probe back to back for `seconds`. */
export async function runLoad(
  base: string,
  probe: Probe,
  concurrency: number,
  seconds: number,
): Promise<LoadResult> {
  const samples: { ms: number; outcome: Outcome }[] = [];
  const statuses: Record<string, number> = {};
  const started = performance.now();
  const deadline = started + seconds * 1000;

  async function worker() {
    while (performance.now() < deadline) {
      const r = await timedGet(base, probe);
      samples.push({ ms: r.ms, outcome: r.outcome });
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = performance.now() - started;
  return { ...requestStats(samples, elapsed), concurrency, statuses };
}

export async function getJson<T>(cfg: Config, path: string): Promise<T> {
  const res = await fetch(cfg.url + path, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      const wait = Math.min(65, Number(res.headers.get("retry-after")) || 10);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
