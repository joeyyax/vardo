import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { createBuildPlacement, NO_PLACEMENT } from "@/lib/docker/build-placement";
import { summarizePlacements } from "@/lib/docker/build-placement-stats";

// A deploy records the target its build ran on, or fell back from, and how its images came back.

const lh = { id: "mesh-lh", name: "Long House" };

describe("createBuildPlacement", () => {
  it("records nothing for a deploy that didn't build", () => {
    expect(createBuildPlacement().columns()).toEqual(NO_PLACEMENT);
  });

  it("records a build here explicitly, with its sizes and memory peak", () => {
    const p = createBuildPlacement();
    p.here();
    p.built({ contextBytes: 2000 });
    p.built({ imageBytes: 9000, contextBytes: null });
    p.peak(700);
    p.peak(500);
    expect(p.columns()).toEqual({ ...NO_PLACEMENT, buildOutcome: "here", buildContextBytes: 2000, imageBytes: 9000, buildPeakBytes: 700 });
  });

  it("keeps a fallback's outcome when the build then runs here", () => {
    const p = createBuildPlacement();
    p.started(lh);
    p.fellBack(lh, "it's unreachable");
    p.here();
    p.peak(100);
    expect(p.columns()).toMatchObject({ buildOutcome: "fallback", buildTargetId: "mesh-lh", buildPeakBytes: 100 });
  });

  it("records the target and sums each image's transfer", () => {
    const p = createBuildPlacement();
    p.started(lh);
    p.transferred({ via: "ssh", ms: 1200, bytes: 4000 });
    p.transferred({ via: "ssh", ms: 800, bytes: 1000 });
    expect(p.columns()).toEqual({
      buildTargetId: "mesh-lh",
      buildTargetName: "Long House",
      buildOutcome: "target",
      buildFallbackReason: null,
      imageTransfer: "ssh",
      imageTransferMs: 2000,
      imageTransferBytes: 5000,
      buildContextBytes: null,
      imageBytes: null,
      buildPeakBytes: null,
    });
  });

  it("calls images that came back different ways mixed, and leaves bytes null without an SSH copy", () => {
    const p = createBuildPlacement();
    p.started(lh);
    p.transferred({ via: "registry", ms: 500 });
    expect(p.columns()).toMatchObject({ imageTransfer: "registry", imageTransferMs: 500, imageTransferBytes: null });
    p.transferred({ via: "registry_skipped", ms: 900, bytes: 10 });
    expect(p.columns()).toMatchObject({ imageTransfer: "mixed", imageTransferMs: 1400, imageTransferBytes: 10 });
  });

  it("records a fallback with the target's reason and drops any partial transfer", () => {
    const p = createBuildPlacement();
    p.started(lh);
    p.transferred({ via: "registry", ms: 500 });
    p.fellBack(lh, "SSH refused the key");
    p.transferred({ via: "ssh", ms: 100 });
    expect(p.columns()).toMatchObject({ buildOutcome: "fallback", buildFallbackReason: "SSH refused the key", imageTransfer: null, imageTransferMs: null });
  });

  it("keeps the first target when a later build goes elsewhere", () => {
    const p = createBuildPlacement();
    p.started(lh);
    p.started({ id: "hz", name: "Hetzner" });
    p.fellBack({ id: "hz", name: "Hetzner" }, "it's unreachable");
    expect(p.columns()).toMatchObject({ buildTargetId: "mesh-lh", buildOutcome: "target" });
  });
});

describe("summarizePlacements", () => {
  type Row = Parameters<typeof summarizePlacements>[0][number];
  const timings = (build: number, exp = 0) => ({
    build: { startedAt: "", endedAt: "", ms: build },
    ...(exp ? { export: { startedAt: "", endedAt: "", ms: exp } } : {}),
  });
  const row = (over: Partial<Row> = {}): Row => ({
    targetId: "lh", outcome: "target", transfer: "registry", transferMs: 1000, transferBytes: null,
    contextBytes: null, imageBytes: null, peakBytes: null, timings: null, ...over,
  });
  const here = (over: Partial<Row> = {}) => row({ targetId: null, outcome: "here", transfer: null, transferMs: null, ...over });

  it("counts builds, fallbacks and ways per target, with medians over builds that ran there", () => {
    const { targets } = summarizePlacements([
      row({ transferMs: 1000, timings: timings(30_000, 2000) }),
      row({ transferMs: 3000, timings: timings(40_000) }),
      row({ transfer: "ssh", transferMs: 9000, transferBytes: 400 }),
      row({ transfer: "registry_skipped", transferMs: 20_000, transferBytes: 800 }),
      row({ outcome: "fallback", transfer: null, transferMs: null, timings: timings(500_000) }),
      row({ targetId: "hz", transfer: "mixed", transferMs: 4000 }),
    ]);
    expect(targets.lh).toMatchObject({
      builds: 5, fallbacks: 1, registry: 2, ssh: 2, skipped: 1, mixed: 0,
      medianTransferMs: 6000, medianTransferBytes: 600, medianBuildMs: 36_000, medianPeakBytes: null,
    });
    expect(targets.hz).toMatchObject({ builds: 1, mixed: 1, medianTransferMs: 4000 });
  });

  it("gives this server every build here, fallbacks included, without fallbacks in its build time", () => {
    const { here: local } = summarizePlacements([
      here({ timings: timings(20_000), contextBytes: 100, imageBytes: 1000, peakBytes: 50 }),
      here({ timings: timings(40_000), contextBytes: 300, imageBytes: 3000, peakBytes: null }),
      row({ outcome: "fallback", transfer: null, transferMs: null, timings: timings(900_000), contextBytes: 200, imageBytes: 2000 }),
      row(),
    ]);
    expect(local).toMatchObject({
      builds: 3, fallbacks: 1, registry: 0, ssh: 0,
      medianBuildMs: 30_000, medianContextBytes: 200, medianImageBytes: 2000, medianPeakBytes: 50, medianTransferMs: null,
    });
  });

  it("has no numbers for a place without builds", () => {
    expect(summarizePlacements([row()]).here).toBeNull();
    expect(summarizePlacements([here()]).targets).toEqual({});
  });
});
