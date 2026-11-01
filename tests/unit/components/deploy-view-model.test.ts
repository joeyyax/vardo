import { describe, it, expect } from "vitest";
import { expectedLive, ghostPieces, zoomFrame, zoomGrid, zoomRange, xPct } from "@/app/(authenticated)/admin/pipeline/timeline";
import {
  builtOnFact,
  compareLanes,
  deployHeadline,
  deploySummary,
  filterStage,
  liveAt,
  releaseFact,
  signedClock,
  splitLogByStage,
  stageSplits,
  timeslip,
  viewPieces,
} from "@/components/deploy-view-model";
import { deployView } from "@/lib/ui/deploy-wait";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineDeploy } from "@/lib/pipeline/types";

// The deploy view: one deploy's Pipeline row zoomed in, its words and its log by stage.

const NOW = Date.parse("2026-10-17T12:00:00Z");
const S = 1000;

const dep = (over: Partial<PipelineDeploy> = {}): PipelineDeploy => ({
  id: "d",
  appId: "a",
  appName: "app",
  appSlug: "app",
  orgName: "Org",
  status: "running",
  stage: "build",
  stop: "build",
  waiting: false,
  waitReason: null,
  failed: false,
  gone: false,
  builder: "lh",
  builderName: "Long House",
  fellBack: false,
  label: "Building on Long House",
  queuedAt: NOW - 73 * S,
  stageSince: NOW - 65 * S,
  finishedAt: null,
  claimSlot: null,
  segments: [
    { stage: "queued", start: NOW - 73 * S, end: NOW - 71 * S },
    { stage: "prepare", start: NOW - 71 * S, end: NOW - 65 * S },
    { stage: "build", start: NOW - 65 * S, end: null },
  ],
  transfer: null,
  queue: null,
  next: null,
  rollback: false,
  failure: null,
  ...over,
});

const medians: PipelineMedians = {
  apps: { a: { prepare: 6 * S, build: 112 * S, start: 9 * S, health: 21 * S, switch: 2 * S, builders: { lh: 125 * S } } },
  builders: { local: 101 * S },
};

const running = deployView({ queued: false, wait: null, started: true });

describe("viewPieces", () => {
  it("names the build by its builder and leaves the rest of the open stage unnamed", () => {
    const pieces = viewPieces(dep(), medians, NOW);
    expect(pieces.map((p) => [p.kind, p.ghost, p.label])).toEqual([
      ["queued", false, ""],
      ["prepare", false, "Prepare"],
      ["build", false, "Build on Long House"],
      ["build", true, ""],
      ["start", true, "Start"],
      ["health", true, "Health check"],
      ["switch", true, "Switch traffic"],
    ]);
    // The rest of the build at its median on Long House.
    expect(pieces[3].end - NOW).toBe(60 * S);
  });

  it("reads a wait for a builder in amber, filters it to Build and names the builder it lands on", () => {
    const d = dep({
      waitReason: "build-slot",
      waiting: true,
      builder: null,
      builderName: null,
      segments: [
        { stage: "queued", start: NOW - 49 * S, end: NOW - 46 * S },
        { stage: "prepare", start: NOW - 46 * S, end: NOW - 41 * S },
        { stage: "wait", start: NOW - 41 * S, end: null },
      ],
      next: { builder: "local", name: "jy0", at: NOW + 26 * S },
    });
    const pieces = viewPieces(d, medians, NOW);
    const wait = pieces.find((p) => p.kind === "wait" && !p.ghost)!;
    expect(wait).toMatchObject({ label: "Waiting for a builder", tone: "warn", stage: "build", open: true });
    expect(pieces.find((p) => p.ghost && p.kind === "build")?.label).toBe("Build on jy0");
    expect(liveAt(d, medians, NOW)).toBe(NOW + (26 + 101 + 9 + 21 + 2) * S);
  });

  it("paints a failed health check red and the rollback after it, both filtering to the health check", () => {
    const d = dep({
      status: "failed",
      stage: "healthcheck",
      stop: "rolledBack",
      finishedAt: NOW,
      segments: [
        { stage: "queued", start: NOW - 156 * S, end: NOW - 154 * S },
        { stage: "build", start: NOW - 154 * S, end: NOW - 56 * S },
        { stage: "health", start: NOW - 56 * S, end: NOW - 8 * S },
      ],
    });
    const pieces = viewPieces(d, medians, NOW);
    expect(pieces.map((p) => [p.kind, p.stage, p.tone])).toEqual([
      ["queued", "queued", null],
      ["build", "build", null],
      ["fail", "health", "error"],
      ["back", "health", "error"],
    ]);
    expect(pieces.at(-1)?.label).toBe("Rolled back");
  });
});

describe("zoomed geometry", () => {
  it("maps the zoom range onto the whole track", () => {
    const f = zoomFrame(NOW, NOW + 100 * S);
    expect(xPct(NOW, f.now, f.windowMs)).toBeCloseTo(0);
    expect(xPct(NOW + 100 * S, f.now, f.windowMs)).toBeCloseTo(100);
    expect(xPct(NOW + 25 * S, f.now, f.windowMs)).toBeCloseTo(25);
  });

  it("runs a live deploy past its expected finish and fits the last run under it", () => {
    const d = dep();
    const ghosts = ghostPieces(d, medians, NOW);
    const end = expectedLive(ghosts)!;
    expect(end).toBe(NOW + (60 + 9 + 21 + 2) * S);
    const r = zoomRange(d, [], ghosts, 123 * S, NOW);
    expect(r.start).toBe(d.queuedAt);
    expect(r.end).toBeGreaterThan(end);
    const longer = zoomRange(d, [], ghosts, 400 * S, NOW);
    expect(longer.end).toBeGreaterThanOrEqual(d.queuedAt + 400 * S);
  });

  it("ends a finished deploy at its finish", () => {
    const d = dep({ status: "success", finishedAt: NOW - 10 * S });
    expect(zoomRange(d, [{ end: NOW - 10 * S }], [], 50 * S, NOW)).toEqual({ start: d.queuedAt, end: NOW - 10 * S });
  });

  it("keeps gridlines to a few dozen at any length", () => {
    expect(zoomGrid(NOW, NOW + 150 * S)).toHaveLength(4);
    expect(zoomGrid(NOW, NOW + 3600 * S).length).toBeLessThan(15);
  });

  it("gives no finish when the ghosts stop short of Switch traffic", () => {
    expect(liveAt(dep(), { apps: { a: { build: 100 * S, builders: {} } }, builders: {} }, NOW)).toBeNull();
  });
});

describe("deployHeadline", () => {
  it("names the stage in flight with its builder", () => {
    expect(deployHeadline({ status: "running" }, { clone: "success", compose: "success", build: "running" }, running, { builder: "Long House" })).toEqual({
      title: "Building on Long House",
      tone: "active",
    });
    expect(deployHeadline({ status: "running" }, { build: "success", deploy: "running" }, running)).toEqual({ title: "Starting", tone: "active" });
  });

  it("reads the row's stage until the stream speaks", () => {
    expect(deployHeadline({ status: "running", stage: "healthcheck" }, {}, running).title).toBe("Checking health");
  });

  it("is amber while it waits for a builder", () => {
    const held = deployView({ queued: false, wait: { reason: "build-slot", ahead: 0 }, started: true });
    expect(deployHeadline({ status: "running" }, { build: "running" }, held)).toEqual({ title: "Waiting for a builder", tone: "warn" });
  });

  it("is red from a failed stage, while it rolls back and once it's done", () => {
    expect(deployHeadline({ status: "running" }, { healthcheck: "failed" }, running)).toEqual({ title: "Health check failed · rolling back", tone: "issue" });
    expect(deployHeadline({ status: "running" }, { stop: "success", restore: "running" }, running)).toEqual({ title: "Rolling back", tone: "issue" });
    expect(deployHeadline({ status: "failed", stage: "healthcheck" }, {}, running)).toEqual({ title: "Health check failed", tone: "issue" });
  });

  it("says Live once it succeeds", () => {
    expect(deployHeadline({ status: "success" }, {}, running)).toEqual({ title: "Live", tone: "good" });
  });
});

describe("deploySummary", () => {
  const head = { title: "Building on Long House", tone: "active" as const };

  it("gives the time left and when it goes live at medians", () => {
    const s = deploySummary(dep(), head, { liveAt: NOW + 109 * S, previousMs: 123 * S, now: NOW, fallback: null });
    expect(s?.main).toBe("About 1m 49s left");
    expect(s?.sub).toMatch(/^Live at about \d{1,2}:\d{2} (AM|PM), at median stage times$/);
  });

  it("falls back to the stream's line without medians", () => {
    expect(deploySummary(dep(), head, { liveAt: null, previousMs: null, now: NOW, fallback: "About 2m left" })?.main).toBe("About 2m left");
  });

  it("says the old version still serves after a failure", () => {
    const s = deploySummary(dep({ status: "failed" }), { title: "Health check failed", tone: "issue" }, { liveAt: null, previousMs: 123 * S, now: NOW, fallback: null });
    expect(s).toEqual({ main: "Old version still serving", sub: "Nothing changed for visitors", tone: "issue" });
  });

  it("compares a finished run with the last one", () => {
    const d = dep({ status: "success", finishedAt: NOW });
    expect(deploySummary(d, { title: "Live", tone: "good" }, { liveAt: null, previousMs: 123 * S, now: NOW, fallback: null })).toEqual({
      main: "1:13",
      sub: "0:50 faster than last time",
      tone: null,
    });
  });
});

describe("facts", () => {
  it("names the builder a waiting deploy gets next", () => {
    const d = dep({ waitReason: "build-slot", builder: null, builderName: null, next: { builder: "local", name: "jy0", at: NOW + 26 * S } });
    expect(builtOnFact(d, NOW)).toEqual({ label: "Built on", value: "Not yet", note: "Next free: jy0 in about 26s" });
  });

  it("names how a remote build's image comes back", () => {
    expect(builtOnFact(dep({ transfer: { via: "registry", ms: 17_000 } }), NOW).note).toBe("Image back over the registry");
  });

  it("says what visitors are served", () => {
    expect(releaseFact(dep(), { title: "", tone: "active" }, true).value).toBe("Previous version live until the switch");
    expect(releaseFact(dep(), { title: "", tone: "active" }, false).value).toBe("Goes live at the switch");
  });
});

describe("splitLogByStage", () => {
  it("groups lines by the stage they were written in and drops the markers", () => {
    const groups = splitLogByStage([
      "[queue] Waiting for the worker",
      "[stage] clone: running",
      "[deploy] Cloning",
      "[stage] clone: success",
      "[stage] compose: running",
      "[deploy] Generated compose",
      "[stage] build: running",
      "[build] Building",
      "",
    ]);
    expect(groups).toEqual([
      { stage: "queued", lines: ["[queue] Waiting for the worker"] },
      { stage: "prepare", lines: ["[deploy] Cloning", "[deploy] Generated compose"] },
      { stage: "build", lines: ["[build] Building"] },
    ]);
  });

  it("keeps a log with no markers in one unstaged group", () => {
    expect(splitLogByStage(["a", "b"])).toEqual([{ stage: null, lines: ["a", "b"] }]);
  });
});

describe("filterStage", () => {
  it("sends a click on the rollback to the failed stage when the log has no rollback lines", () => {
    const groups = splitLogByStage(["[stage] healthcheck: running", "[deploy] 502"]);
    expect(filterStage("rollingBack", groups)).toBe("health");
    expect(filterStage("build", groups)).toBe("build");
    expect(filterStage("queued", groups)).toBeNull();
  });
});

describe("an auto-rollback", () => {
  it("draws no ghosts and builds nothing", () => {
    const d = dep({ rollback: true, stop: "gate", stage: "restore", segments: [{ stage: "queued", start: NOW - 14 * S, end: NOW - 13 * S }] });
    const pieces = viewPieces(d, medians, NOW);
    expect(pieces.some((p) => p.ghost)).toBe(false);
    expect(pieces.at(-1)).toMatchObject({ kind: "back", stage: "rollingBack", label: "Rolling back", open: true });
    expect(liveAt(d, medians, NOW)).toBeNull();
    expect(builtOnFact(d, NOW).value).toBe("No build");
  });
});

// A finished run: `queue` seconds in line, then each stage's seconds in loop order.
const run = (id: string, queuedAt: number, queue: number, stages: [string, number][], over: Partial<PipelineDeploy> = {}): PipelineDeploy => {
  let at = queuedAt + queue * S;
  const segments = [{ stage: "queued" as const, start: queuedAt, end: at }, ...stages.map(([stage, s]) => ({ stage: stage as "build", start: at, end: (at += s * S) }))];
  return dep({ id, status: "success", stage: "cleanup", stop: "live", queuedAt, finishedAt: at, segments, ...over });
};

describe("compareLanes", () => {
  const previous = run("p", NOW - 86_400 * S, 40, [["prepare", 7], ["build", 101], ["start", 11], ["health", 22], ["switch", 3]]);
  const failed = run("f", NOW - 3 * 86_400 * S, 5, [["prepare", 9], ["build", 88], ["health", 30]], { status: "rolled_back", stage: "healthcheck", stop: "rolledBack", failed: true });

  it("starts every run on this deploy's start line, past its queue", () => {
    const lanes = compareLanes(dep(), { previous, failures: [failed], medians }, NOW);
    const line = NOW - 71 * S;
    expect(lanes.map((l) => [l.kind, l.pieces[0].start - line])).toEqual([
      ["median", 0],
      ["last", 0],
      ["failed", 0],
    ]);
    // The median builds at its time on Long House.
    expect(lanes[0].end - line).toBe((6 + 125 + 9 + 21 + 2) * S);
    expect(lanes[1].end - line).toBe(144 * S);
  });

  it("ends a failed run in the stage it died in, without the rollback", () => {
    const [lane] = compareLanes(dep(), { previous: null, failures: [failed], medians: { apps: {}, builders: {} } }, NOW);
    expect(lane).toMatchObject({ kind: "failed", meta: "Health check" });
    expect(lane.pieces.map((p) => p.kind)).toEqual(["prepare", "build", "health"]);
  });

  it("has nothing to compare without history, nor for an auto-rollback", () => {
    expect(compareLanes(dep(), { previous: null, failures: [], medians: { apps: {}, builders: {} } }, NOW)).toEqual([]);
    expect(compareLanes(dep({ rollback: true }), { previous, failures: [failed], medians }, NOW)).toEqual([]);
  });
});

describe("stageSplits and the timeslip", () => {
  const done = run("d", NOW - 200 * S, 30, [["prepare", 5], ["build", 120], ["start", 9], ["health", 25], ["switch", 2]]);

  it("measures each finished stage against its median and stops at the one in flight", () => {
    expect(stageSplits(dep(), medians, NOW).map((s) => [s.stage, s.deltaMs])).toEqual([["prepare", 0]]);
    expect(stageSplits(done, medians, NOW).map((s) => s.deltaMs / S)).toEqual([-1, -5, 0, 4, 0]);
  });

  it("gives a successful deploy its timeslip, and none while it runs or after a failure", () => {
    expect(timeslip(done, medians, NOW)?.map((s) => s.stage)).toEqual(["prepare", "build", "start", "health", "switch"]);
    expect(timeslip(dep(), medians, NOW)).toBeNull();
    expect(timeslip({ ...done, status: "failed" }, medians, NOW)).toBeNull();
  });

  it("signs the difference", () => {
    expect(signedClock(-12 * S)).toBe("−0:12");
    expect(signedClock(3 * S)).toBe("+0:03");
    expect(signedClock(400)).toBe("0:00");
  });
});
