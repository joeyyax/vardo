import { describe, it, expect } from "vitest";
import {
  bucketSeries,
  counterRates,
  cronMarks,
  drillEvents,
  focusWindow,
  lastDeployOf,
  latest,
  memoryLimitOf,
  mergeSpans,
  pickFocus,
  ribbonDeploy,
  sumSeries,
  uptimeRatio,
} from "@/lib/admin-apps/shape";

// The Apps page's pure shaping: steps, rates, limits, uptime, the ribbon and the drill-in's focus.

const M = 60_000;
const T = 1_800_000_000_000;

describe("bucketSeries", () => {
  it("averages points into their step and leaves empty steps null", () => {
    expect(bucketSeries([[T, 10], [T + 30_000, 20], [T + 2 * M, 5]], T, M, 3)).toEqual([15, null, 5]);
  });

  it("drops points outside the window", () => {
    expect(bucketSeries([[T - 1, 9], [T + 3 * M, 9]], T, M, 3)).toEqual([null, null, null]);
  });
});

describe("counterRates", () => {
  it("turns a cumulative counter into bytes per second", () => {
    expect(counterRates([[T, 0], [T + M, 6_000], [T + 2 * M, 12_000]], T, M, 3)).toEqual([null, 100, 100]);
  });

  it("leaves the step after a restart unknown", () => {
    expect(counterRates([[T, 9_000], [T + M, 100], [T + 2 * M, 6_100]], T, M, 3)).toEqual([null, null, 100]);
  });
});

describe("sumSeries", () => {
  it("adds step by step and keeps a step null only when every series is", () => {
    expect(sumSeries([[1, null, null], [2, 3, null]], 3)).toEqual([3, 3, null]);
  });
});

describe("latest", () => {
  it("takes the newest value within the fresh steps", () => {
    expect(latest([1, 2, null])).toBe(2);
    expect(latest([1, null, null, null])).toBeNull();
  });
});

describe("memoryLimitOf", () => {
  it("sums the members' limits, preferring the running container's", () => {
    expect(memoryLimitOf([{ containerMemoryLimit: 512 * 1024 ** 2, memoryLimit: 256 }, { containerMemoryLimit: null, memoryLimit: 256 }])).toBe(768 * 1024 ** 2);
  });

  it("is unlimited when any member is", () => {
    expect(memoryLimitOf([{ containerMemoryLimit: 0, memoryLimit: null }, { containerMemoryLimit: 1024, memoryLimit: null }])).toBeNull();
    expect(memoryLimitOf([])).toBeNull();
  });
});

describe("uptimeRatio", () => {
  it("is null without measured minutes", () => {
    expect(uptimeRatio(0, 0)).toBeNull();
    expect(uptimeRatio(1437, 3)).toBeCloseTo(0.9979, 4);
  });
});

describe("ribbonDeploy", () => {
  it("keeps waits for a builder and marks rollbacks as failures", () => {
    const d = ribbonDeploy({
      queuedAt: T,
      finishedAt: T + 5 * M,
      status: "rolled_back",
      segments: [
        { stage: "queued", start: T, end: T + 1_000 },
        { stage: "wait", start: T + 1_000, end: T + M },
        { stage: "build", start: T + M, end: T + 3 * M },
      ],
    });
    expect(d).toEqual({ start: T, end: T + 5 * M, failed: true, waits: [{ start: T + 1_000, end: T + M }] });
  });
});

describe("cronMarks", () => {
  it("counts runs and failures per bucket", () => {
    const marks = cronMarks([{ at: T + 1, failed: false }, { at: T + 2, failed: true }, { at: T + 20 * M, failed: false }], 15 * M);
    expect(marks.map((m) => [m.runs, m.failed])).toEqual([[2, 1], [1, 0]]);
  });
});

describe("mergeSpans", () => {
  it("joins overlapping outages, an open one staying open", () => {
    expect(mergeSpans([{ start: T + M, end: null, failed: true }, { start: T, end: T + 2 * M, failed: true }])).toEqual([{ start: T, end: null, failed: true }]);
    expect(mergeSpans([{ start: T, end: T + M, failed: true }, { start: T + 2 * M, end: T + 3 * M, failed: true }])).toHaveLength(2);
  });
});

describe("lastDeployOf", () => {
  it("reads duration from start to finish", () => {
    expect(lastDeployOf({ status: "rolled_back", startedAt: T, finishedAt: T + 90_000 })).toEqual({ at: T + 90_000, ms: 90_000, status: "rolled_back" });
    expect(lastDeployOf(null)).toBeNull();
  });
});

describe("pickFocus", () => {
  const now = T + 10 * 60 * M;
  const deploys = [
    { id: "a", status: "success", queuedAt: T + 9 * 60 * M, finishedAt: T + 9 * 60 * M + 2 * M },
    { id: "b", status: "rolled_back", queuedAt: T + 60 * M, finishedAt: T + 64 * M },
  ];

  it("prefers the latest failure over a newer clean deploy", () => {
    expect(pickFocus(deploys, [], now)).toMatchObject({ kind: "rollback", deployId: "b" });
  });

  it("takes an outage when it's the latest notable event", () => {
    expect(pickFocus(deploys, [{ start: T + 2 * 60 * M, end: T + 2 * 60 * M + 3 * M, failed: true }], now)).toMatchObject({ kind: "outage", deployId: null });
  });

  it("reads an outage a bad deploy caused as the deploy", () => {
    expect(pickFocus(deploys, [{ start: T + 63 * M, end: T + 66 * M, failed: true }], now)).toMatchObject({ kind: "rollback", deployId: "b" });
  });

  it("falls back to the last deploy, then to quiet", () => {
    expect(pickFocus([deploys[0]], [], now)).toMatchObject({ kind: "deploy", deployId: "a" });
    expect(pickFocus([], [], now)).toEqual({ kind: "quiet", at: now, end: null, deployId: null });
  });
});

describe("focusWindow", () => {
  it("frames an hour around the event without passing now", () => {
    const now = T + 10 * M;
    const w = focusWindow({ kind: "deploy", at: T, end: T + M, deployId: "a" }, now);
    expect(w.to).toBe(now);
    expect(w.to - w.from).toBeGreaterThanOrEqual(60 * M);
    expect(focusWindow({ kind: "quiet", at: now, end: null, deployId: null }, now)).toEqual({ from: now - 60 * M, to: now });
  });
});

describe("drillEvents", () => {
  it("lists deploys, outages, backups and failed crons newest first", () => {
    const events = drillEvents(
      {
        deploys: [{ id: "b", status: "rolled_back", queuedAt: T + 10 * M, finishedAt: T + 14 * M, failure: "502 from /healthz" }],
        outages: [{ start: T + 12 * M, end: T + 14 * M + 30_000, failed: true }],
        backups: [{ start: T, end: T + M, failed: false }],
        crons: [{ at: T + 5 * M, name: "Sync", failed: true }, { at: T + 6 * M, name: "Sync", failed: false }],
      },
      T + 60 * M,
    );
    expect(events.map((e) => e.text)).toEqual(["Down 2:30", "Deploy rolled back · 502 from /healthz", "Sync failed", "Backed up"]);
    expect(events[0].tone).toBe("issue");
  });
});
