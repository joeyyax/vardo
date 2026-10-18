import { describe, it, expect } from "vitest";
import { axisTicks, barPieces, builderLanes, ghostPieces, headText, place, xPct, WINDOWS } from "@/app/(authenticated)/admin/pipeline/timeline";
import { attentionRows, headChip, summarize } from "@/app/(authenticated)/admin/pipeline/summary";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { PipelineBuilder, PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";

// The Deploys card's geometry and the page's sentence, from a snapshot.

const NOW = Date.parse("2026-10-17T12:00:00Z");
const S = 1000;
const W = WINDOWS["5m"];

const dep = (over: Partial<PipelineDeploy>): PipelineDeploy => ({
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
  builder: "local",
  builderName: "jy0",
  fellBack: false,
  label: "Building on jy0",
  queuedAt: NOW - 60 * S,
  stageSince: NOW - 50 * S,
  finishedAt: null,
  claimSlot: null,
  segments: [
    { stage: "queued", start: NOW - 60 * S, end: NOW - 58 * S },
    { stage: "prepare", start: NOW - 58 * S, end: NOW - 50 * S },
    { stage: "build", start: NOW - 50 * S, end: null },
  ],
  transfer: null,
  queue: null,
  next: null,
  rollback: false,
  failure: null,
  ...over,
});

const medians: PipelineMedians = { apps: { a: { prepare: 5 * S, build: 100 * S, start: 10 * S, health: 20 * S, switch: 2 * S, builders: {} } }, builders: { local: 90 * S } };

const builder = (over: Partial<PipelineBuilder> = {}): PipelineBuilder => ({
  id: "local",
  name: "jy0",
  kind: "local",
  slots: 1,
  online: true,
  holders: [],
  refusals: [],
  busy: null,
  ...over,
});

describe("track geometry", () => {
  it("puts now a fifth of the way from the right and clamps spans to the track", () => {
    expect(xPct(NOW, NOW, W)).toBeCloseTo(100 / 1.2);
    expect(place(NOW - 2 * W, NOW - W - 1, NOW, W)).toBeNull();
    expect(place(NOW - 2 * W, NOW, NOW, W)?.left).toBe(0);
  });

  it("labels the axis on whole minutes, none crowding now", () => {
    const ticks = axisTicks(NOW, W);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.every((t) => t.at % 60_000 === 0 && t.at < NOW)).toBe(true);
  });
});

describe("a deploy's bar", () => {
  it("names the stage and host at its head with the time in it", () => {
    expect(headText(dep({}), NOW)).toBe("Building on jy0 · 0:50");
  });

  it("paints the failed stage red and hatches the rollback after it", () => {
    const d = dep({
      status: "failed",
      stage: "healthcheck",
      stop: "rolledBack",
      finishedAt: NOW - 10 * S,
      segments: [
        { stage: "queued", start: NOW - 60 * S, end: NOW - 58 * S },
        { stage: "health", start: NOW - 30 * S, end: NOW - 10 * S },
      ],
    });
    const kinds = barPieces(d, NOW).map((p) => p.kind);
    expect(kinds).toEqual(["queued", "fail", "back"]);
  });

  it("draws ghosts at the app's medians from now, and none without one", () => {
    const ghosts = ghostPieces(dep({}), medians, NOW);
    expect(ghosts.map((g) => g.kind)).toEqual(["build", "start", "health", "switch"]);
    expect(ghosts[0].end - NOW).toBe(40 * S);
    expect(ghostPieces(dep({}), { apps: {}, builders: {} }, NOW)).toEqual([]);
  });

  it("sends a waiting deploy's ghost to the builder it likely gets", () => {
    const d = dep({
      waitReason: "build-slot",
      waiting: true,
      stop: "gate",
      next: { builder: "local", name: "jy0", at: NOW + 20 * S },
      segments: [{ stage: "wait", start: NOW - 30 * S, end: null }],
    });
    const ghosts = ghostPieces(d, medians, NOW);
    expect(ghosts[0]).toMatchObject({ kind: "wait", start: NOW, end: NOW + 20 * S });
    expect(ghosts[1]).toMatchObject({ kind: "build", start: NOW + 20 * S, end: NOW + 110 * S });
    expect(ghostPieces({ ...d, next: null }, medians, NOW)).toEqual([]);
  });
});

describe("builder lanes", () => {
  it("keeps a holder on its slot's lane and lands the next waiting deploy after it", () => {
    const holder = dep({});
    const waiting = dep({ id: "w", appName: "next", waitReason: "build-slot", next: { builder: "local", name: "jy0", at: NOW + 40 * S }, segments: [] });
    const [lane] = builderLanes([builder({ holders: [{ token: "d:1", deploymentId: "d", since: NOW - 50 * S }] })], [holder, waiting], medians, NOW, W);
    expect(lane.bars.map((b) => [b.kind, b.deployId])).toEqual([
      ["build", "d"],
      ["next", "w"],
    ]);
  });

  it("hatches a linked instance's own build and marks a refusal on it", () => {
    const b = builder({
      id: "lh",
      name: "Long House",
      kind: "mesh",
      holders: [{ token: "build:mesh-x", deploymentId: null, since: NOW - 50 * S }],
      refusals: [{ at: NOW - 30 * S, deploymentId: "d", reason: "memory", needBytes: 2 * 1024 ** 3, freeBytes: 1024 ** 3 }],
    });
    const [lane] = builderLanes([b], [dep({})], medians, NOW, W);
    expect(lane.bars[0]).toMatchObject({ kind: "own", label: "" });
    expect(lane.marks[0].title).toBe("Long House refused app: needs 2.0 GiB, 1.0 GiB free");
  });
});

const snap = (over: Partial<PipelineSnapshot>): PipelineSnapshot => ({
  at: NOW,
  instanceName: "jy0",
  deploySlots: { busy: 0, total: 8, onTargets: 0 },
  builders: [builder()],
  deploys: [],
  recent: [],
  medians,
  jobs: [],
  loops: [],
  activity: [],
  totals: { live: 12, elsewhere: 0, fellBack: 0, failed: 0, medianToLiveMs: 168 * S, lastLiveAt: NOW - 14 * 60 * S },
  upcoming: [],
  overdue: [],
  ...over,
});

describe("summary and attention", () => {
  it("says how many are in flight and when a builder frees", () => {
    const waiting = dep({ id: "w", waitReason: "build-slot", waiting: true, next: { builder: "local", name: "jy0", at: NOW + 26 * S } });
    const s = snap({ deploys: [dep({}), waiting] });
    expect(summarize(s, [])).toMatchObject({ title: "2 deploys in flight. 1 is waiting for a builder.", text: "Every builder is full; one should free on jy0 in about 26s." });
    expect(headChip(s, [])).toEqual({ label: "2 in flight", tone: "signal" });
  });

  it("leads with a failed health check and asks for it", () => {
    const failed = dep({ status: "failed", stage: "healthcheck", stop: "rolledBack", finishedAt: NOW - 8 * S, failure: "3 of 3 checks failed" });
    const s = snap({ deploys: [failed] });
    const rows = attentionRows(s);
    expect(rows[0]).toMatchObject({ tone: "issue", title: "app failed its health check", text: "3 of 3 checks failed. The old version kept serving." });
    expect(summarize(s, rows)).toMatchObject({ title: "app failed its health check.", text: "The old version kept serving. Nothing else is in flight." });
  });

  it("drops a failure once the app deploys again", () => {
    const failed = dep({ status: "failed", stage: "build", stop: "build", failed: true, finishedAt: NOW - 60 * S, queuedAt: NOW - 120 * S });
    const again = dep({ id: "again", queuedAt: NOW - 30 * S });
    expect(attentionRows(snap({ deploys: [again], recent: [failed] }))).toEqual([]);
  });

  it("reads a long quiet in hours", () => {
    const s = snap({ totals: { live: 0, elsewhere: 0, fellBack: 0, failed: 0, lastLiveAt: NOW - 5.2 * 3600 * S } });
    expect(summarize(s, [])).toMatchObject({ title: "Nothing has deployed in 5 hours.", text: "Builders are idle." });
  });
});
