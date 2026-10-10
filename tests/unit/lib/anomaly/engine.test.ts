import { describe, expect, it } from "vitest";
import { SAMPLE_MS, computeBaseline, utcOffset, type Baseline, type Sample } from "@/lib/anomaly/baseline";
import { AnomalyEngine } from "@/lib/anomaly/engine";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const start = Date.UTC(2026, 9, 7, 12, 0);

function history(days: number, value: number, end: number): Sample[] {
  const out: Sample[] = [];
  for (let at = end - days * DAY + SAMPLE_MS; at <= end; at += SAMPLE_MS) out.push({ at, value });
  return out;
}

const cpuBaseline = (days: number, end: number): Baseline => computeBaseline(history(days, 1, end), end)!;

/** Feeds one CPU reading a minute from `from` and evaluates after each. */
function run(engine: AnomalyEngine, from: number, values: number[], baseline: Baseline, quiet = false) {
  let last = engine.evaluate("a1", { cpu: baseline }, { now: from, sensitivity: "normal", offset: utcOffset, quiet });
  const flushed: { signal: string; at: number; value: number }[] = [];
  values.forEach((cpu, i) => {
    const at = from + i * MIN;
    flushed.push(...engine.record("a1", { cpu }, at, quiet));
    last = engine.evaluate("a1", { cpu: baseline }, { now: at, sensitivity: "normal", offset: utcOffset, quiet });
  });
  return { last, flushed };
}

const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

describe("AnomalyEngine", () => {
  it("stays unknown while the app is warming up", () => {
    const { last } = run(new AnomalyEngine(), start, repeat(300, 20), cpuBaseline(2, start));
    expect(last.state).toBe("unknown");
  });

  it("finds a sustained jump once warm", () => {
    const { last } = run(new AnomalyEngine(), start, [...repeat(1, 5), ...repeat(300, 16)], cpuBaseline(7, start));
    expect(last.state).toBe("judged");
    if (last.state !== "judged") return;
    expect(last.findings).toHaveLength(1);
    expect(last.findings[0]).toMatchObject({ signal: "cpu", verdict: { fires: true } });
  });

  it("is quiet for a normal app", () => {
    const { last } = run(new AnomalyEngine(), start, repeat(1.2, 30), cpuBaseline(7, start));
    expect(last).toEqual({ state: "judged", findings: [] });
  });

  it("stays unknown in a quiet window and learns nothing from it", () => {
    const { last, flushed } = run(new AnomalyEngine(), start, repeat(300, 30), cpuBaseline(7, start), true);
    expect(last.state).toBe("unknown");
    expect(flushed).toEqual([]);
  });

  it("persists five-minute averages of normal readings", () => {
    const { flushed } = run(new AnomalyEngine(), start, [...repeat(1, 5), ...repeat(3, 5), 2], cpuBaseline(7, start));
    expect(flushed).toEqual([
      { signal: "cpu", at: start, value: 1 },
      { signal: "cpu", at: start + SAMPLE_MS, value: 3 },
    ]);
  });

  it("doesn't learn from an episode", () => {
    const { flushed } = run(new AnomalyEngine(), start, [...repeat(1, 11), ...repeat(300, 30), 1], cpuBaseline(7, start));
    expect(flushed).toEqual([
      { signal: "cpu", at: start, value: 1 },
      { signal: "cpu", at: start + SAMPLE_MS, value: 1 },
    ]);
  });
});
