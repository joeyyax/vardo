import { describe, it, expect } from "vitest";
import { assembleSnapshot, describeEvent, type DeployRow, type SnapshotInputs } from "@/lib/pipeline/snapshot";
import { groupLoops } from "@/lib/pipeline/loops";
import { deploySlotLine } from "@/lib/pipeline/deploy-slot-line";
import type { PipelineEntry } from "@/lib/pipeline/events";
import type { LoopStatus } from "@/lib/worker/status";

// The Pipeline snapshot: builders and their slot holders, where each deploy sits, jobs, loops and the activity feed.

const NOW = Date.parse("2026-10-17T12:00:00Z");

const row = (over: Partial<DeployRow>): DeployRow => ({
  id: "d",
  appId: "a",
  appName: "app",
  status: "running",
  stage: "build",
  waitReason: null,
  waitingSince: null,
  queuedAt: NOW - 60_000,
  claimedAt: NOW - 50_000,
  finishedAt: null,
  buildOutcome: null,
  buildTargetId: null,
  buildTargetName: null,
  ...over,
});

const loop = (over: Partial<LoopStatus>): LoopStatus => ({
  name: "backup-tick",
  roles: ["web"],
  singleton: true,
  feature: null,
  enabled: true,
  runningHere: true,
  lease: null,
  state: "ok",
  stale: false,
  lastTickAt: new Date(NOW - 5_000).toISOString(),
  lastOkAt: new Date(NOW - 5_000).toISOString(),
  lastError: null,
  consecutiveFailures: 0,
  intervalMs: 60_000,
  lastHolder: null,
  ...over,
});

const inputs = (over: Partial<SnapshotInputs> = {}): SnapshotInputs => ({
  now: NOW,
  instanceName: "jy0",
  deploySlots: 4,
  localSlots: 2,
  gate: { local: [], targets: {}, ready: null },
  targets: [{ id: "lh", name: "Long House", kind: "mesh", maxConcurrent: 2 }],
  deploys: [],
  backups: [],
  drills: [],
  crons: [],
  loops: [],
  events: [],
  totals: { live: 0, elsewhere: 0, fellBack: 0, failed: 0 },
  ...over,
});

describe("assembleSnapshot", () => {
  it("shows empty lanes for every builder when nothing is in flight", () => {
    const s = assembleSnapshot(inputs());
    expect(s.deploys).toEqual([]);
    expect(s.builders).toEqual([
      { id: "local", name: "jy0", kind: "local", slots: 2, online: true, holders: [], refusals: [], busy: null },
      { id: "lh", name: "Long House", kind: "mesh", slots: 2, online: null, holders: [], refusals: [], busy: null },
    ]);
    expect(s.deploySlots).toEqual({ busy: 0, total: 4, onTargets: 0 });
  });

  it("puts each deploy on the builder whose slot it holds", () => {
    const s = assembleSnapshot(
      inputs({
        gate: { local: [{ token: "here:aa", since: NOW - 30_000 }], targets: { lh: ["there:bb", "build:mesh-p1-cc"] }, ready: ["lh"] },
        deploys: [row({ id: "here", appName: "scope" }), row({ id: "there", appName: "wha-docs" })],
      }),
    );
    const byId = Object.fromEntries(s.deploys.map((d) => [d.id, d]));
    expect(byId.here).toMatchObject({ stop: "build", builder: "local", builderName: "jy0", label: "Building on jy0" });
    expect(byId.there).toMatchObject({ stop: "build", builder: "lh", builderName: "Long House", label: "Building on Long House" });
    expect(s.builders[1].online).toBe(true);
    expect(s.builders[1].holders.map((h) => h.deploymentId)).toEqual(["there", null]);
  });

  it("keeps where a finished deploy built, and marks a fallback from events or the row", () => {
    const s = assembleSnapshot(
      inputs({
        deploys: [
          row({ id: "done", status: "success", stage: "done", finishedAt: NOW - 1_000, buildOutcome: "target", buildTargetId: "lh", buildTargetName: "Long House" }),
          row({ id: "fb", stage: "deploy" }),
        ],
        events: [{ kind: "fallback", deploymentId: "fb", builder: "lh", name: "Long House", reason: "timeout", at: NOW - 2_000 }],
      }),
    );
    expect(s.deploys[0]).toMatchObject({ stop: "live", builderName: "Long House", fellBack: false, stageSince: NOW - 1_000 });
    expect(s.deploys[1]).toMatchObject({ stop: "swap", fellBack: true });
  });

  it("times a stage from its latest stage event, or from the wait", () => {
    const s = assembleSnapshot(
      inputs({
        deploys: [row({ id: "a", stage: "healthcheck" }), row({ id: "w", waitReason: "build-slot", waitingSince: NOW - 7_000 })],
        events: [
          { kind: "stage", deploymentId: "a", stage: "healthcheck", status: "running", at: NOW - 4_000 },
          { kind: "stage", deploymentId: "a", stage: "deploy", status: "running", at: NOW - 9_000 },
        ],
      }),
    );
    expect(s.deploys[0].stageSince).toBe(NOW - 4_000);
    expect(s.deploys[1]).toMatchObject({ stop: "gate", waiting: true, stageSince: NOW - 7_000 });
  });

  it("puts jobs at their step", () => {
    const s = assembleSnapshot(
      inputs({
        backups: [
          { id: "b1", name: "scope · db", status: "running", startedAt: NOW - 9_000, finishedAt: null, verifying: false },
          { id: "b2", name: "wha · uploads", status: "success", startedAt: NOW - 90_000, finishedAt: NOW - 3_000, verifying: false },
        ],
        drills: [{ backupId: "b0", name: "scope · db", startedAt: NOW, finishedAt: null, failed: false }],
        crons: [{ id: "c1", name: "app · sync", running: true, startedAt: NOW - 2_000, finishedAt: null, failed: false }],
      }),
    );
    expect(s.jobs.map((j) => [j.id, j.step])).toEqual([
      ["backup:b1", 0],
      ["backup:b2", 2],
      ["drill:b0", 0],
      ["cron:c1", 0],
    ]);
  });

  it("lists recent events newest first, with failed loops, and leaves routine ones out", () => {
    const s = assembleSnapshot(
      inputs({
        deploys: [row({ id: "d1", appName: "scope" })],
        eventApps: { old: "wha-docs" },
        events: [
          { kind: "stage", deploymentId: "old", stage: "done", status: "success", at: NOW - 1_000 },
          { kind: "stage", deploymentId: "d1", stage: "build", status: "running", at: NOW - 2_000 },
          { kind: "queued", deploymentId: "d1", at: NOW - 3_000 },
        ],
        loops: [loop({ name: "cron-tick", state: "failing", lastError: "boom", lastTickAt: new Date(NOW - 1_500).toISOString() })],
      }),
    );
    expect(s.activity.map((a) => a.text)).toEqual(["wha-docs is live", "Cron failed its last run", "scope joined the queue"]);
  });
});

describe("describeEvent", () => {
  const ctx = { appNames: new Map([["d", "scope"]]), builderName: new Map([["lh", "Long House"]]), instanceName: "jy0" };

  it("says where a build went and when it fell back", () => {
    expect(describeEvent({ kind: "slot", action: "claim", token: "d:a", deploymentId: "d", builder: "lh", at: 0 }, ctx)?.text).toBe(
      "scope is building on Long House",
    );
    expect(describeEvent({ kind: "slot", action: "claim", token: "d:a", deploymentId: "d", builder: "local", at: 0 }, ctx)).toBeNull();
    expect(describeEvent({ kind: "slot", action: "claim", token: "build:mesh-x", deploymentId: null, builder: "local", at: 0 }, ctx)?.text).toBe(
      "A linked instance is building on jy0",
    );
    expect(describeEvent({ kind: "fallback", deploymentId: "d", builder: "lh", name: "Long House", reason: "offline", at: 0 }, ctx)).toEqual({
      text: "scope: Long House couldn't build (offline); building on jy0 instead",
      tone: "warning",
    });
  });

  it("calls a health check failure a rollback", () => {
    expect(describeEvent({ kind: "stage", deploymentId: "d", stage: "healthcheck", status: "failed", at: 0 }, ctx)?.text).toBe(
      "scope failed its health check; the old version kept serving",
    );
  });
});

describe("deploy slots", () => {
  it("counts a run on a target's deploy slot apart from this server's", () => {
    const s = assembleSnapshot(
      inputs({
        deploySlots: 1,
        gate: { local: [], targets: { lh: ["t:aa"] }, ready: ["lh"] },
        deploys: [row({ id: "h", claimSlot: null }), row({ id: "t", claimSlot: "target" })],
      }),
    );
    expect(s.deploySlots).toEqual({ busy: 1, total: 1, onTargets: 1 });
    expect(deploySlotLine(s)).toBe("1 of 1 running here, 1 more on Long House");
  });

  it("reads only this server's line with nothing on a target", () => {
    const s = assembleSnapshot(inputs({ deploySlots: 8, deploys: [row({ id: "a" }), row({ id: "b" })] }));
    expect(deploySlotLine(s)).toBe("2 of 8 running here");
  });
});

describe("refusals", () => {
  const refused = (over: Partial<Extract<PipelineEntry, { kind: "refused" }>> = {}): PipelineEntry => ({
    kind: "refused",
    deploymentId: "d",
    builder: "lh",
    name: "Long House",
    reason: "memory",
    needBytes: 6 * 1024 ** 3,
    freeBytes: 2 * 1024 ** 3,
    busy: true,
    at: NOW - 10_000,
    ...over,
  });

  it("marks the refusing builder and lists the latest refusal once", () => {
    const s = assembleSnapshot(
      inputs({
        deploys: [row({ id: "d", appName: "scope", waitReason: "build-slot" })],
        events: [refused({ at: NOW - 5_000 }), refused({ at: NOW - 20_000 })],
      }),
    );
    const lh = s.builders.find((b) => b.id === "lh")!;
    expect(lh.refusals).toEqual([{ at: NOW - 5_000, deploymentId: "d", reason: "memory", needBytes: 6 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 }]);
    expect(lh.busy).toBe(true);
    expect(s.activity.map((a) => a.text)).toEqual(["scope: Long House turned the build down (needs 6.0 GiB, 2.0 GiB free); waiting for a builder"]);
  });

  it("forgets a refusal after five minutes and says less for an older peer", () => {
    const s = assembleSnapshot(inputs({ events: [refused({ at: NOW - 6 * 60_000 })] }));
    expect(s.builders.find((b) => b.id === "lh")!.refusals).toEqual([]);
    const old = refused({ reason: null, needBytes: null, freeBytes: null, busy: null });
    expect(describeEvent(old, { appNames: new Map(), builderName: new Map(), instanceName: "jy0" })?.text).toBe(
      "A deploy: Long House turned the build down; waiting for a builder",
    );
  });
});

describe("segments, queue and likely builder", () => {
  it("gives an in-flight deploy its open stage and a finished one closed stages", () => {
    const timings = { stages: { clone: { start: NOW - 40_000, end: NOW - 30_000 }, build: { start: NOW - 30_000 } } };
    const s = assembleSnapshot(inputs({ deploys: [row({ id: "d", timings })] }));
    expect(s.deploys[0].segments.map((g) => [g.stage, g.end === null])).toEqual([
      ["queued", false],
      ["prepare", false],
      ["build", true],
    ]);
  });

  it("takes the queue's own count for the place in line", () => {
    const s = assembleSnapshot(inputs({ deploys: [row({ id: "d", status: "queued", waitReason: "deploy-slot", waitAhead: 2, waitTotal: 5, waitEta: NOW + 60_000 })] }));
    expect(s.deploys[0].queue).toEqual({ reason: "deploy-slot", position: 3, of: 5, eta: NOW + 60_000 });
  });

  it("sends a waiting deploy to the slot that frees soonest, and the next to the one after", () => {
    const s = assembleSnapshot(
      inputs({
        localSlots: 1,
        gate: { local: [{ token: "h:aa", since: NOW - 10_000 }], targets: { lh: ["t:bb", "t2:cc"] }, ready: ["lh"] },
        events: [
          { kind: "slot", action: "claim", token: "t:bb", deploymentId: "t", builder: "lh", at: NOW - 50_000 },
          { kind: "slot", action: "claim", token: "t2:cc", deploymentId: "t2", builder: "lh", at: NOW - 55_000 },
        ],
        deploys: [
          row({ id: "h", appId: "a" }),
          row({ id: "t", appId: "a" }),
          row({ id: "t2", appId: "a" }),
          row({ id: "w1", appId: "a", waitReason: "build-slot", waitAhead: 0 }),
          row({ id: "w2", appId: "a", waitReason: "build-slot", waitAhead: 1 }),
        ],
        medians: { apps: { a: { builders: { local: 60_000, lh: 90_000 } } }, builders: {} },
      }),
    );
    const next = (id: string) => s.deploys.find((d) => d.id === id)!.next;
    expect(next("w1")).toEqual({ builder: "lh", name: "Long House", at: NOW + 35_000 });
    expect(next("w2")).toEqual({ builder: "lh", name: "Long House", at: NOW + 40_000 });
    expect(s.builders.find((b) => b.id === "lh")!.holders.map((h) => h.since)).toEqual([NOW - 50_000, NOW - 55_000]);
  });

  it("says nothing about the builder without a median", () => {
    const s = assembleSnapshot(
      inputs({
        localSlots: 1,
        gate: { local: [{ token: "h:aa", since: NOW - 10_000 }], targets: {}, ready: [] },
        deploys: [row({ id: "h" }), row({ id: "w", waitReason: "build-slot" })],
      }),
    );
    expect(s.deploys.find((d) => d.id === "w")!.next).toBeNull();
  });
});

describe("groupLoops", () => {
  it("groups known loops, puts unknown ones under Other and flags a failing one", () => {
    const groups = groupLoops([loop({ name: "deploy-claim" }), loop({ name: "brand-new" }), loop({ name: "cron-tick", state: "failing" })]);
    expect(groups.map((g) => [g.label, g.loops.map((l) => l.label)])).toEqual([
      ["Deploys", ["Deploy queue"]],
      ["Backups and cron", ["Cron"]],
      ["Other", ["brand-new"]],
    ]);
    expect(groups[1].loops[0].failed).toBe(true);
  });
});
