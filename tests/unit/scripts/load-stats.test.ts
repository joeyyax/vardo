import { describe, it, expect, vi } from "vitest";
import { percentile, requestStats, summarize } from "../../../scripts/load/stats";
import { compareReports, delta, renderComparison, type Report } from "../../../scripts/load/compare";
import {
  Pacer, defaultRate, isRateLimited, parseBackoffMs, DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS,
} from "../../../scripts/load/pacing";
import { runLoad } from "../../../scripts/load/client";
import { createSseParser } from "../../../scripts/load/sse";
import { parseTick, toMiB, mergeTick } from "../../../scripts/load/sampler";

describe("percentile", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("uses nearest rank", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("rounds the rank up on small samples", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([7], 99)).toBe(7);
  });

  it("returns null when empty", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("summarize", () => {
  it("sorts unsorted input without mutating it", () => {
    const input = [30, 10, 20];
    const s = summarize(input);
    expect(input).toEqual([30, 10, 20]);
    expect(s).toMatchObject({ count: 3, min: 10, max: 30, mean: 20, p50: 20, p99: 30 });
  });

  it("handles no samples", () => {
    expect(summarize([])).toMatchObject({ count: 0, p50: null, mean: null });
  });
});

describe("requestStats", () => {
  it("keeps 429s out of the error rate and latency", () => {
    const s = requestStats(
      [
        { ms: 10, outcome: "ok" },
        { ms: 20, outcome: "ok" },
        { ms: 500, outcome: "error" },
        { ms: 1, outcome: "limited" },
        { ms: 1, outcome: "limited" },
      ],
      2000,
    );
    expect(s).toMatchObject({ requests: 5, ok: 2, limited: 2, errors: 1 });
    expect(s.errorRate).toBeCloseTo(1 / 3);
    expect(s.rps).toBe(1);
    expect(s.latency.max).toBe(20);
  });

  it("reports a zero error rate when everything was limited", () => {
    expect(requestStats([{ ms: 1, outcome: "limited" }], 1000).errorRate).toBe(0);
  });
});

function report(target: string, results: Report["results"]): Report {
  return { version: 1, startedAt: "2026-10-08T00:00:00Z", target, options: {}, results, notes: [] };
}

describe("delta", () => {
  it("treats lower latency as better", () => {
    expect(delta("p95", 100, 80)).toMatchObject({ abs: -20, pct: -20, verdict: "better" });
    expect(delta("p95", 100, 130).verdict).toBe("worse");
  });

  it("treats higher throughput as better", () => {
    expect(delta("rps", 100, 150).verdict).toBe("better");
    expect(delta("rps", 100, 50).verdict).toBe("worse");
    expect(delta("lag.p50", 10, 20).verdict).toBe("worse");
  });

  it("calls small moves noise", () => {
    expect(delta("p50", 100, 103).verdict).toBe("same");
  });

  it("handles zero and missing baselines", () => {
    expect(delta("errors", 0, 0)).toMatchObject({ pct: 0, verdict: "same" });
    expect(delta("errors", 0, 3)).toMatchObject({ pct: null, verdict: "worse" });
    expect(delta("p50", null, 3).verdict).toBe("n/a");
  });
});

describe("compareReports", () => {
  const before = report("a", [
    { id: "apps@c5", label: "apps c=5", metrics: { p95: 100, rps: 50 } },
    { id: "gone", label: "gone", metrics: { p95: 1 } },
  ]);
  const after = report("b", [
    { id: "apps@c5", label: "apps c=5", metrics: { p95: 60, rps: 49, extra: 2 } },
    { id: "new", label: "new", metrics: { p95: 1 } },
  ]);

  it("pairs rows by id and lists unmatched ones", () => {
    const { deltas, onlyBefore, onlyAfter } = compareReports(before, after);
    expect(deltas.find((d) => d.metric === "p95")).toMatchObject({ abs: -40, verdict: "better" });
    expect(deltas.find((d) => d.metric === "rps")?.verdict).toBe("same");
    expect(deltas.find((d) => d.metric === "extra")).toMatchObject({ before: null, after: 2 });
    expect(onlyBefore).toEqual(["gone"]);
    expect(onlyAfter).toEqual(["new"]);
  });

  it("renders a table with a verdict summary", () => {
    const text = renderComparison(before, after);
    expect(text).toContain("apps c=5");
    expect(text).toContain("-40.0%");
    expect(text).toContain("1 better, 0 worse");
    expect(text).toContain("only in before: gone");
  });
});

describe("createSseParser", () => {
  it("reassembles events split across chunks and skips comments", () => {
    const seen: { event: string; data: string }[] = [];
    const feed = createSseParser((e) => seen.push(e));
    feed(": keepalive\n\nevent: po");
    feed('int\ndata: {"timestamp":1}\n\ndata: plain\n\n');
    expect(seen).toEqual([
      { event: "point", data: '{"timestamp":1}' },
      { event: "message", data: "plain" },
    ]);
  });
});

describe("server sampling", () => {
  const output = [
    "@@stats",
    "vardo-frontend 12.5% 180.4MiB / 2GiB",
    "vardo-redis 3.0% 1.5GiB / 4GiB",
    "@@redis",
    "used_memory:104857600",
    "used_memory_peak:209715200",
    "@@pg",
    "17",
  ].join("\n");

  it("converts units to MiB", () => {
    expect(toMiB("1.5GiB")).toBe(1536);
    expect(toMiB("512KiB")).toBe(0.5);
    expect(toMiB("nonsense")).toBeNull();
  });

  it("parses a tick", () => {
    const tick = parseTick(output);
    expect(tick.containers["vardo-frontend"]).toEqual({ cpuPct: 12.5, memMiB: 180.4 });
    expect(tick.containers["vardo-redis"].memMiB).toBe(1536);
    expect(tick.redisUsedMiB).toBe(100);
    expect(tick.redisPeakMiB).toBe(200);
    expect(tick.pgConnections).toBe(17);
  });

  it("leaves redis and postgres null when the commands print nothing", () => {
    const tick = parseTick("@@stats\n@@redis\n@@pg\n");
    expect(tick).toMatchObject({ redisUsedMiB: null, pgConnections: null });
  });

  it("keeps the peak across ticks", () => {
    const empty = { samples: 0, containers: {}, redisUsedMiB: null, redisPeakMiB: null, pgConnections: null };
    const a = mergeTick(empty, parseTick(output));
    const lower = parseTick(output.replace("12.5%", "2.0%").replace("17", "5"));
    const b = mergeTick(a, lower);
    expect(b.samples).toBe(2);
    expect(b.containers["vardo-frontend"].cpuPct).toBe(12.5);
    expect(b.pgConnections).toBe(17);
  });
});

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe("defaultRate", () => {
  it("is 90% of the read limit", () => {
    expect(defaultRate()).toBe(108);
    expect(defaultRate(60, 0.5)).toBe(30);
  });
});

describe("Pacer", () => {
  it("spaces slots evenly", () => {
    const p = new Pacer(60, 0);
    expect([p.reserve(0), p.reserve(0), p.reserve(0)]).toEqual([0, 1000, 2000]);
  });

  it("doesn't bank idle time as a burst", () => {
    const p = new Pacer(60, 0);
    p.reserve(0);
    expect([p.reserve(10_000), p.reserve(10_000)]).toEqual([10_000, 11_000]);
  });

  it("stays under the limit over a minute", () => {
    const p = new Pacer(defaultRate(), 0);
    const slots = Array.from({ length: 200 }, () => p.reserve(0));
    // Any 60s window holds at most 108 slots, so the 109th is a full minute after the first.
    expect(slots[108] - slots[0]).toBeGreaterThanOrEqual(59_999);
  });

  it("holds later slots after a penalty", () => {
    const p = new Pacer(60, 0);
    p.reserve(0);
    p.penalize(5000);
    expect(p.reserve(1000)).toBe(5000);
    p.penalize(2000);
    expect(p.reserve(1000)).toBe(6000);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new Pacer(0)).toThrow();
  });
});

describe("parseBackoffMs", () => {
  it("reads Retry-After seconds", () => {
    expect(parseBackoffMs(headers({ "retry-after": "12" }))).toBe(12_000);
  });

  it("reads Retry-After as an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseBackoffMs(headers({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), now)).toBe(30_000);
  });

  it("prefers Retry-After over reset headers", () => {
    expect(parseBackoffMs(headers({ "retry-after": "3", "ratelimit-reset": "40" }))).toBe(3000);
  });

  it("falls back to RateLimit-Reset as delta seconds or epoch", () => {
    expect(parseBackoffMs(headers({ "ratelimit-reset": "8" }))).toBe(8000);
    const now = 1_800_000_000_000;
    expect(parseBackoffMs(headers({ "x-ratelimit-reset": "1800000020" }), now)).toBe(20_000);
  });

  it("caps long waits and floors past dates at zero", () => {
    expect(parseBackoffMs(headers({ "retry-after": "9999" }))).toBe(MAX_BACKOFF_MS);
    expect(parseBackoffMs(headers({ "retry-after": "Thu, 01 Jan 2026 00:00:00 GMT" }), Date.parse("2027-01-01"))).toBe(0);
  });

  it("returns null without usable headers", () => {
    expect(parseBackoffMs(headers({}))).toBeNull();
    expect(parseBackoffMs(headers({ "retry-after": "soon" }))).toBeNull();
    expect(DEFAULT_BACKOFF_MS).toBeGreaterThan(0);
  });
});

describe("isRateLimited", () => {
  it("flags above 5% only", () => {
    expect(isRateLimited(100, 5)).toBe(false);
    expect(isRateLimited(100, 6)).toBe(true);
    expect(isRateLimited(0, 0)).toBe(false);
  });
});

describe("runLoad against a limiter", () => {
  it("backs off on 429 using Retry-After", async () => {
    let calls = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("{}", calls === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200 });
    });
    const r = await runLoad("http://x", { id: "t", label: "t", path: "/" }, 2, 1);
    spy.mockRestore();
    expect(r.limited).toBe(1);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("caps the request rate when paced", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const r = await runLoad("http://x", { id: "t", label: "t", path: "/" }, 5, 1, 120);
    spy.mockRestore();
    expect(r.requests).toBeGreaterThanOrEqual(1);
    expect(r.requests).toBeLessThanOrEqual(3);
    expect(r.rateLimited).toBe(false);
  });

  it("multiplies the target by token count", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      seen.push(String((init?.headers as Record<string, string>).authorization));
      return new Response("{}", { status: 200 });
    });
    const r = await runLoad("http://x", { id: "t", label: "t", path: "/", tokens: ["a", "b"] }, 1, 1, 120);
    spy.mockRestore();
    expect(r.targetPerMin).toBe(240);
    expect(seen.slice(0, 2)).toEqual(["Bearer a", "Bearer b"]);
  });
});
