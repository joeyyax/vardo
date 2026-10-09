import { describe, it, expect } from "vitest";
import { percentile, requestStats, summarize } from "../../../scripts/load/stats";
import { compareReports, delta, renderComparison, type Report } from "../../../scripts/load/compare";
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
