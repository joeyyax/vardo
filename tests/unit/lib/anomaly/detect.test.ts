import { describe, expect, it } from "vitest";
import type { BucketStats, Sample } from "@/lib/anomaly/baseline";
import { judgeSignal, lineFor } from "@/lib/anomaly/detect";
import { SIGNALS } from "@/lib/anomaly/signals";

const MIN = 60_000;
const MiB = 1024 ** 2;
const now = 1_000 * MIN;

const flat = (value: number): BucketStats => ({ median: value, mad: 0, p95: value, count: 100 });

/** One reading a minute, ending at `now`. */
function minutes(values: number[]): Sample[] {
  return values.map((value, i) => ({ at: now - (values.length - 1 - i) * MIN, value }));
}

const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

describe("lineFor", () => {
  it("lets the floor decide for an idle app", () => {
    const line = lineFor(SIGNALS.cpu, flat(0.2), "normal");
    expect(line.threshold).toBeCloseTo(5.2);
    const egress = lineFor(SIGNALS.egress, flat(0), "normal");
    expect(egress.threshold).toBeCloseTo(MiB / 60);
  });

  it("scales with a busy app's own level", () => {
    expect(lineFor(SIGNALS.cpu, flat(100), "normal").threshold).toBe(300);
    expect(lineFor(SIGNALS.cpu, flat(100), "low").threshold).toBe(400);
    expect(lineFor(SIGNALS.cpu, flat(100), "high").threshold).toBe(200);
  });

  it("trips sooner on egress than on other signals", () => {
    const egress = lineFor(SIGNALS.egress, flat(10 * MiB), "normal").threshold;
    const ingress = lineFor(SIGNALS.ingress, flat(10 * MiB), "normal").threshold;
    expect(egress).toBeLessThan(ingress);
  });

  it("scales floors with sensitivity", () => {
    expect(lineFor(SIGNALS.cpu, flat(0), "low").threshold).toBe(10);
    expect(lineFor(SIGNALS.cpu, flat(0), "high").threshold).toBe(2.5);
  });
});

describe("judgeSignal", () => {
  const line = lineFor(SIGNALS.cpu, flat(2), "normal");

  it("says nothing without a fresh reading", () => {
    expect(judgeSignal([], SIGNALS.cpu, line, now)).toBeNull();
    expect(judgeSignal([{ at: now - 10 * MIN, value: 90 }], SIGNALS.cpu, line, now)).toBeNull();
  });

  it("fires only after fifteen minutes over the line", () => {
    expect(judgeSignal(minutes(repeat(90, 16)), SIGNALS.cpu, line, now)?.fires).toBe(true);
    expect(judgeSignal(minutes([...repeat(1, 6), ...repeat(90, 10)]), SIGNALS.cpu, line, now)?.fires).toBe(false);
  });

  it("ignores a noisy idle app under the floor", () => {
    const verdict = judgeSignal(minutes(repeat(4, 20)), SIGNALS.cpu, lineFor(SIGNALS.cpu, flat(0.5), "normal"), now);
    expect(verdict).toMatchObject({ fires: false, holds: false });
  });

  it("fires on egress after ten minutes and calls it critical", () => {
    const egress = lineFor(SIGNALS.egress, flat(0), "normal");
    const verdict = judgeSignal(minutes([...repeat(0, 5), ...repeat(20 * MiB / 60, 11)]), SIGNALS.egress, egress, now);
    expect(verdict).toMatchObject({ fires: true, severity: "critical" });
    expect(verdict?.since).toBe(now - 10 * MIN);
  });

  it("can't fire before readings cover the window, as after a restart", () => {
    expect(judgeSignal(minutes(repeat(90, 5)), SIGNALS.cpu, line, now)?.fires).toBe(false);
  });

  it("holds until readings stay under the clear line for ten minutes", () => {
    const dipped = judgeSignal(minutes([...repeat(90, 16), ...repeat(1, 5)]), SIGNALS.cpu, line, now);
    expect(dipped).toMatchObject({ fires: false, holds: true });
    const settled = judgeSignal(minutes([...repeat(90, 16), ...repeat(1, 11)]), SIGNALS.cpu, line, now);
    expect(settled).toMatchObject({ fires: false, holds: false });
  });

  it("is critical for any signal far over the line", () => {
    expect(judgeSignal(minutes(repeat(15, 16)), SIGNALS.cpu, line, now)?.severity).toBe("warning");
    expect(judgeSignal(minutes(repeat(800, 16)), SIGNALS.cpu, line, now)?.severity).toBe("critical");
  });
});
