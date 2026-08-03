import { describe, it, expect } from "vitest";

import {
  BASELINE_MS,
  MIN_BASELINE_SPAN_MS,
  SAMPLE_MS,
  SETTLE_MS,
  STALE_AFTER_MS,
  WINDOW_MS,
  WINDOW_SAMPLES,
  errorRateReading,
  errorRateSurface,
  errorRateTone,
  median,
  overlapsQuiet,
  percentile,
  quietWindows,
  windowSums,
  type RateSample,
} from "@/lib/ui/error-rate";

const NOW = Date.parse("2026-07-31T12:00:00Z");

/**
 * `days` of samples on the collector's grid ending at NOW. `errors` is called
 * with the sample's age in ms so a test can shape any part of the history.
 */
function history(days: number, errors: (agoMs: number) => number, lines = 200): RateSample[] {
  const count = Math.floor((days * 86_400_000) / SAMPLE_MS);
  const samples: RateSample[] = [];
  for (let i = count; i >= 0; i--) {
    const ago = i * SAMPLE_MS;
    samples.push({ at: NOW - ago, errors: errors(ago), lines });
  }
  return samples;
}

/** A steady app: two matches every five minutes for a week. */
const steady = () => history(7, () => 2);

function read(samples: RateSample[], quiet = [] as ReturnType<typeof quietWindows>) {
  return errorRateReading({ now: NOW, samples, quiet });
}

describe("windowSums", () => {
  it("sums whole windows and stamps them at the last sample", () => {
    const samples = history(1, () => 3);
    const windows = windowSums(samples);
    expect(windows[windows.length - 1]).toEqual({
      at: NOW,
      errors: 3 * WINDOW_SAMPLES,
      lines: 200 * WINDOW_SAMPLES,
    });
  });

  it("never sums across a gap in collection", () => {
    const dense = history(1, () => 1);
    // Drop an hour out of the middle.
    const gapped = dense.filter((s) => s.at < NOW - 7_200_000 || s.at > NOW - 3_600_000);
    const windows = windowSums(gapped);
    const spanning = windows.filter((w) => w.at > NOW - 3_600_000 && w.at < NOW - 3_600_000 + WINDOW_MS);
    expect(spanning).toHaveLength(0);
  });
});

describe("median and percentile", () => {
  it("takes the midpoint of an even sample", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("lands a percentile on a real observation", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1)).toBe(10);
    expect(percentile([], 0.99)).toBe(0);
  });
});

describe("cold start", () => {
  it("says nothing on day one", () => {
    const reading = read(history(1, () => 2));
    expect(reading.status).toBe("learning");
    expect(reading.baseline).toBeNull();
    expect(reading.detail).toContain("3 days");
  });

  it("stays silent through a day-one burst that would fire later", () => {
    const reading = read(history(1, (ago) => (ago < WINDOW_MS ? 200 : 1)));
    expect(reading.status).toBe("learning");
  });

  it("reports how much history it has", () => {
    const day = read(history(1, () => 2));
    expect(day.coverage).toBeGreaterThan(0);
    expect(day.coverage).toBeLessThan(MIN_BASELINE_SPAN_MS / BASELINE_MS);
  });

  it("compares once three days are covered", () => {
    expect(read(history(3.1, () => 2)).status).toBe("normal");
  });
});

describe("baseline", () => {
  it("is the median half hour, not the mean", () => {
    // One enormous hour a week does not move the median.
    const reading = read(
      history(7, (ago) => (ago > 3 * 86_400_000 && ago < 3 * 86_400_000 + 3_600_000 ? 500 : 2)),
    );
    expect(reading.baseline).toBe(2 * WINDOW_SAMPLES);
  });

  it("excludes the evaluation window from what it is compared against", () => {
    const reading = read(history(7, (ago) => (ago < WINDOW_MS ? 50 : 2)));
    expect(reading.baseline).toBe(2 * WINDOW_SAMPLES);
  });

  it("judges a chatty app against its own chattiness", () => {
    // 60 matches every five minutes is normal here, and stays normal.
    expect(read(history(7, () => 60)).status).toBe("normal");
  });
});

describe("step change", () => {
  it("raises when a quiet app starts erroring", () => {
    const reading = read(history(7, (ago) => (ago < WINDOW_MS ? 30 : 0)));
    expect(reading.status).toBe("elevated");
    expect(reading.recent).toBe(30 * WINDOW_SAMPLES);
  });

  it("stays quiet below the floor", () => {
    const reading = read(history(7, (ago) => (ago < WINDOW_MS ? 2 : 0)));
    expect(reading.status).toBe("normal");
  });

  it("stays quiet when a chatty app is only a little worse", () => {
    const reading = read(history(7, (ago) => (ago < WINDOW_MS ? 90 : 60)));
    expect(reading.status).toBe("normal");
  });

  it("raises when a chatty app is far worse than it has ever been", () => {
    const reading = read(history(7, (ago) => (ago < WINDOW_MS ? 900 : 60)));
    expect(reading.status).toBe("elevated");
  });

  it("ignores a burst it has seen before", () => {
    // 40 matches per sample for half an hour, every three hours, all week.
    const periodic = (ago: number) => (Math.floor(ago / WINDOW_MS) % 6 === 0 ? 40 : 0);
    expect(read(history(7, periodic)).status).toBe("normal");
  });

  it("ignores a rise that is only more traffic", () => {
    // Ten times the errors, but ten times the log lines too.
    const samples = history(7, (ago) => (ago < WINDOW_MS ? 200 : 20), 100).map((s) =>
      s.at > NOW - WINDOW_MS ? { ...s, lines: 1000 } : s,
    );
    expect(read(samples).status).toBe("normal");
  });

  it("raises when errors climb and total output does not", () => {
    const samples = history(7, (ago) => (ago < WINDOW_MS ? 200 : 20), 1000);
    expect(read(samples).status).toBe("elevated");
  });
});

describe("deploy suppression", () => {
  const burst = () => history(7, (ago) => (ago < WINDOW_MS ? 200 : 1));

  it("fires on that burst with no deploy behind it", () => {
    expect(read(burst()).status).toBe("elevated");
  });

  it("holds off while a deploy is settling", () => {
    const quiet = quietWindows(
      [{ startedAt: NOW - 20 * 60_000, finishedAt: NOW - 18 * 60_000 }],
      [],
    );
    expect(read(burst(), quiet).status).toBe("settling");
  });

  it("holds off after a container restart", () => {
    const quiet = quietWindows([], [new Date(NOW - 5 * 60_000)]);
    expect(read(burst(), quiet).status).toBe("settling");
  });

  it("judges again once the settle window has passed", () => {
    const quiet = quietWindows(
      [{ startedAt: NOW - 3_600_000, finishedAt: NOW - 3_500_000 }],
      [],
    );
    expect(read(burst(), quiet).status).toBe("elevated");
  });

  it("caps an unfinished deploy so a hung row cannot suppress forever", () => {
    const quiet = quietWindows([{ startedAt: NOW - 6 * 3_600_000, finishedAt: null }], []);
    expect(read(burst(), quiet).status).toBe("elevated");
  });

  it("keeps a deploy's own noise out of the baseline", () => {
    // A daily deploy that prints 500 matches must not become "usual".
    const deployAgo = (n: number) => n * 86_400_000;
    const samples = history(7, (ago) =>
      [1, 2, 3, 4, 5, 6].some((d) => ago > deployAgo(d) && ago < deployAgo(d) + WINDOW_MS) ? 500 : 2,
    );
    const quiet = quietWindows(
      [1, 2, 3, 4, 5, 6].map((d) => ({
        startedAt: NOW - deployAgo(d) - WINDOW_MS,
        finishedAt: NOW - deployAgo(d),
      })),
      [],
    );
    expect(read(samples, quiet).baseline).toBe(2 * WINDOW_SAMPLES);
  });
});

describe("staleness", () => {
  it("reads a stopped app as not collecting, never as zero", () => {
    const stale = history(7, () => 2).map((s) => ({ ...s, at: s.at - STALE_AFTER_MS - SAMPLE_MS }));
    const reading = read(stale);
    expect(reading.status).toBe("idle");
    expect(reading.recent).toBeNull();
  });

  it("reads an app with no samples at all as not collecting", () => {
    expect(read([]).status).toBe("idle");
  });
});

describe("quiet windows", () => {
  it("extends a deploy past its finish so startup logging is covered", () => {
    const [window] = quietWindows([{ startedAt: NOW - 60_000, finishedAt: NOW }], []);
    expect(window.to).toBe(NOW + SETTLE_MS);
  });

  it("skips a row with an unparseable stamp", () => {
    expect(quietWindows([{ startedAt: "not a date", finishedAt: null }], [null])).toEqual([]);
  });

  it("detects any overlap, not just containment", () => {
    const windows = [{ from: 100, to: 200 }];
    expect(overlapsQuiet(50, 120, windows)).toBe(true);
    expect(overlapsQuiet(180, 400, windows)).toBe(true);
    expect(overlapsQuiet(201, 400, windows)).toBe(false);
  });
});

describe("presentation", () => {
  it("gives only elevated a warning hue", () => {
    expect(errorRateTone("elevated")).toContain("status-warning");
    expect(errorRateTone("normal")).toContain("status-success");
    expect(errorRateTone("learning")).toBe("text-muted-foreground");
    expect(errorRateSurface("learning")).toBe("border-border bg-muted/40");
  });

  it("says what the numbers were", () => {
    const reading = read(steady());
    expect(reading.detail).toContain(String(2 * WINDOW_SAMPLES));
    expect(reading.detail).toContain("30 minutes");
  });
});
