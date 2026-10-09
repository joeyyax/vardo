import { authHeaders, type Config } from "./client";
import { summarize, type Summary } from "./stats";

export type SseKind = "metrics" | "logs";

export type SseResult = {
  kind: SseKind;
  streams: number;
  connected: number;
  limited: number;
  failed: number;
  connect: Summary;
  firstEvent: Summary;
  lag: Summary;
  gap: Summary;
  events: number;
};

type Parsed = { event: string; data: string };

/** Incremental SSE parser; feed it decoded text chunks. */
export function createSseParser(onEvent: (e: Parsed) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent({ event, data: data.join("\n") });
    }
  };
}

function streamPath(cfg: Config, kind: SseKind): string {
  const base = `/api/v1/organizations/${cfg.org}/apps/${cfg.app}`;
  return kind === "metrics" ? `${base}/stats/stream` : `${base}/logs/stream`;
}

/**
 * Holds `n` streams open for `seconds`. Lag is client receive time minus the
 * server's own `timestamp` on metrics points, so it includes clock skew on a remote target.
 */
export async function holdStreams(
  cfg: Config,
  kind: SseKind,
  n: number,
  seconds: number,
): Promise<SseResult> {
  const connectMs: number[] = [];
  const firstMs: number[] = [];
  const lagMs: number[] = [];
  const gapMs: number[] = [];
  let events = 0;
  let limited = 0;
  let failed = 0;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), seconds * 1000);

  async function one() {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(cfg.url + streamPath(cfg, kind), {
        headers: authHeaders(cfg, { accept: "text/event-stream" }),
        signal: stop.signal,
      });
    } catch {
      if (!stop.signal.aborted) failed++;
      return;
    }
    if (res.status === 429) {
      limited++;
      await res.body?.cancel();
      return;
    }
    if (!res.ok || !res.body?.getReader || !res.headers.get("content-type")?.includes("text/event-stream")) {
      failed++;
      await res.body?.cancel();
      return;
    }
    connectMs.push(performance.now() - t0);

    let sawFirst = false;
    let last = 0;
    const parse = createSseParser((e) => {
      const now = performance.now();
      events++;
      if (!sawFirst) {
        sawFirst = true;
        firstMs.push(now - t0);
      } else {
        gapMs.push(now - last);
      }
      last = now;
      if (kind === "metrics" && e.event === "point") {
        try {
          const ts = (JSON.parse(e.data) as { timestamp?: number }).timestamp;
          if (typeof ts === "number") lagMs.push(Date.now() - ts);
        } catch { /* skip malformed point */ }
      }
    });

    const decoder = new TextDecoder();
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
    } catch { /* aborted at the end of the hold */ }
  }

  await Promise.all(Array.from({ length: n }, one));
  clearTimeout(timer);

  return {
    kind,
    streams: n,
    connected: connectMs.length,
    limited,
    failed,
    connect: summarize(connectMs),
    firstEvent: summarize(firstMs),
    lag: summarize(lagMs),
    gap: summarize(gapMs),
    events,
  };
}
