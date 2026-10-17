import { describe, it, expect } from "vitest";
import { deploySegments, stageDurations, stageMedians } from "@/lib/pipeline/segments";
import { summarizeMedians, type MedianRow } from "@/lib/pipeline/medians";

// A deploy's shared stages from its stage timings, and medians over many.

const T = 1_000_000;
const row = (timings: object | null, over: Partial<Parameters<typeof deploySegments>[0]> = {}) => ({
  status: "success",
  queuedAt: T,
  claimedAt: T + 5_000,
  finishedAt: T + 100_000,
  timings: timings as never,
  ...over,
});

const full = {
  stages: {
    clone: { start: T + 5_000, end: T + 8_000 },
    compose: { start: T + 8_000, end: T + 10_000 },
    build: { start: T + 10_000, end: T + 60_000 },
    deploy: { start: T + 60_000, end: T + 70_000 },
    healthcheck: { start: T + 70_000, end: T + 90_000 },
    routing: { start: T + 90_000, end: T + 92_000 },
    cleanup: { start: T + 92_000, end: T + 100_000 },
  },
  waits: [{ reason: "build-slot", start: T + 10_000, end: T + 30_000 }],
};

describe("deploySegments", () => {
  it("folds clone and compose into Prepare and carves the builder wait out of Build", () => {
    expect(deploySegments(row(full)).map((s) => [s.stage, s.start - T, s.end! - T])).toEqual([
      ["queued", 0, 5_000],
      ["prepare", 5_000, 10_000],
      ["wait", 10_000, 30_000],
      ["build", 30_000, 60_000],
      ["start", 60_000, 70_000],
      ["health", 70_000, 90_000],
      ["switch", 90_000, 92_000],
      ["live", 92_000, 100_000],
    ]);
  });

  it("leaves a running deploy's open stage and wait open", () => {
    const timings = { stages: { clone: { start: T + 5_000, end: T + 8_000 }, build: { start: T + 8_000 } }, waits: [{ reason: "build-slot", start: T + 8_000 }] };
    const segs = deploySegments(row(timings, { status: "running", finishedAt: null }));
    expect(segs.at(-1)).toEqual({ stage: "wait", start: T + 8_000, end: null });
  });

  it("ends a crashed or cancelled deploy's open stage at its finish", () => {
    const timings = { stages: { clone: { start: T + 5_000 } } };
    const segs = deploySegments(row(timings, { status: "failed", finishedAt: T + 50_000 }));
    expect(segs.at(-1)).toEqual({ stage: "prepare", start: T + 5_000, end: T + 50_000 });
  });

  it("reads a row from before stage spans from its timed phases", () => {
    const iso = (ms: number) => new Date(T + ms).toISOString();
    const legacy = { clone: { startedAt: iso(5_000), endedAt: iso(8_000), ms: 3_000 }, build: { startedAt: iso(9_000), endedAt: iso(40_000), ms: 31_000 } };
    expect(deploySegments(row(legacy)).map((s) => s.stage)).toEqual(["queued", "prepare", "build"]);
  });

  it("shows a queued deploy as queued, still open", () => {
    expect(deploySegments(row(null, { status: "queued", claimedAt: null, finishedAt: null }))).toEqual([{ stage: "queued", start: T, end: null }]);
  });
});

describe("medians", () => {
  it("takes each stage's median and leaves the wait out of Build", () => {
    expect(stageDurations(row(full))).toEqual({ prepare: 5_000, build: 30_000, start: 10_000, health: 20_000, switch: 2_000, live: 8_000 });
    expect(stageMedians([{ build: 10 }, { build: 30 }, { build: 20, start: 5 }])).toEqual({ build: 20, start: 5 });
  });

  it("splits an app's build medians by builder and keeps fallbacks out of them", () => {
    const base: Omit<MedianRow, "buildOutcome" | "buildTargetId"> = { appId: "a", queuedAt: T, claimedAt: T + 5_000, finishedAt: T + 100_000, timings: full as never };
    const m = summarizeMedians(
      [
        { ...base, buildOutcome: "here", buildTargetId: null },
        { ...base, buildOutcome: "target", buildTargetId: "lh" },
        { ...base, buildOutcome: "fallback", buildTargetId: "lh" },
      ],
      { here: { medianBuildMs: 40_000, medianTransferMs: null } as never, targets: { lh: { medianBuildMs: 20_000, medianTransferMs: 5_000 } as never } },
    );
    expect(m.apps.a.builders).toEqual({ local: 30_000, lh: 30_000 });
    expect(m.apps.a.health).toBe(20_000);
    expect(m.builders).toEqual({ local: 40_000, lh: 25_000 });
  });
});
