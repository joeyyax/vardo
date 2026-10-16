import { describe, expect, it } from "vitest";
import { BASELINE_WINDOW_MS, SAMPLE_MS, computeBaseline, peakOf, utcOffset, type Baseline, type Sample } from "@/lib/anomaly/baseline";
import { AnomalyEngine, type FlushedSample } from "@/lib/anomaly/engine";
import { SIGNALS, type SignalKey } from "@/lib/anomaly/signals";

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
function run(engine: AnomalyEngine, from: number, values: number[], baseline: Baseline, quiet = false, peaks?: Partial<Record<SignalKey, number>>) {
  let last = engine.evaluate("a1", { cpu: baseline }, { now: from, sensitivity: "normal", offset: utcOffset, quiet, peaks });
  const flushed: FlushedSample[] = [];
  const all: FlushedSample[] = [];
  values.forEach((cpu, i) => {
    const at = from + i * MIN;
    flushed.push(...engine.record("a1", { cpu }, at, quiet, all));
    last = engine.evaluate("a1", { cpu: baseline }, { now: at, sensitivity: "normal", offset: utcOffset, quiet, peaks });
  });
  return { last, flushed, all };
}

const fires = (last: ReturnType<typeof run>["last"]) => last.state === "judged" && last.findings.some((f) => f.verdict.fires);

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

/** A week idle at 1% CPU, with an earlier hour at `burst` that only the all series kept. */
function burstHistory(burst: number) {
  const idle = history(7, 1, start);
  const spikeAt = start - 3 * DAY - 6 * 60 * MIN;
  const spike = Array.from({ length: 12 }, (_, i) => ({ at: spikeAt + i * SAMPLE_MS, value: burst }));
  return { baseline: computeBaseline(idle, start)!, peak: peakOf([...idle, ...spike], start - BASELINE_WINDOW_MS, start) };
}

describe("peak gate", () => {
  const burst = [...repeat(1, 5), ...repeat(300, 20)];

  it("doesn't fire in an idle hour for a burst its history already holds", () => {
    const { baseline, peak } = burstHistory(300);
    const { last } = run(new AnomalyEngine(), start, burst, baseline, false, { cpu: peak });
    expect(last.state).toBe("judged");
    expect(fires(last)).toBe(false);
  });

  it("fires for a burst more than twice its history's peak", () => {
    const { baseline, peak } = burstHistory(100);
    expect(fires(run(new AnomalyEngine(), start, burst, baseline, false, { cpu: peak }).last)).toBe(true);
  });

  it("fires as before with no history", () => {
    const { baseline } = burstHistory(300);
    expect(fires(run(new AnomalyEngine(), start, burst, baseline, false, { cpu: 0 }).last)).toBe(true);
    expect(fires(run(new AnomalyEngine(), start, burst, baseline, false, {}).last)).toBe(true);
  });

  it("keeps episode samples in the all series and out of the peak", () => {
    const engine = new AnomalyEngine();
    const baseline = cpuBaseline(7, start);
    const { last, all } = run(engine, start, [...repeat(1, 11), ...repeat(300, 30)], baseline);
    const now = start + 40 * MIN;
    expect(fires(last)).toBe(true);
    expect(peakOf(all, start - DAY, now)).toBe(300);

    const peak = peakOf(all, now - BASELINE_WINDOW_MS, engine.peakCutoff("a1", "cpu", now));
    expect(peak).toBe(1);
    expect(fires(run(engine, now + MIN, repeat(300, 5), baseline, false, { cpu: peak }).last)).toBe(true);
  });

  it("takes the peak from before the sustain window when no episode is open", () => {
    expect(new AnomalyEngine().peakCutoff("a1", "cpu", start)).toBe(start - SIGNALS.cpu.sustainMs - SAMPLE_MS);
  });
});
