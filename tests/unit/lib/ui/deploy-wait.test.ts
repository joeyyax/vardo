import { describe, it, expect } from "vitest";
import {
  activeDeploy,
  applyWait,
  deployClock,
  deployWaitOf,
  deployCardText,
  deployView,
  NO_WAIT,
  parseWaitEvent,
  rowHold,
  seedWait,
  streamIdMs,
  type WaitEvent,
  type WaitState,
} from "@/lib/ui/deploy-wait";

const T0 = 1_760_000_000_000;
const at = (ms: number, seq = 0) => `${T0 + ms}-${seq}`;

function fold(events: WaitEvent[]): WaitState {
  return events.reduce(applyWait, NO_WAIT);
}

describe("streamIdMs", () => {
  it("reads the millisecond prefix", () => {
    expect(streamIdMs("1760000000123-4")).toBe(1_760_000_000_123);
  });

  it("rejects anything that isn't a stream id", () => {
    expect(streamIdMs(undefined)).toBeNull();
    expect(streamIdMs("")).toBeNull();
    expect(streamIdMs("abc-1")).toBeNull();
    expect(streamIdMs("1760000000123")).toBeNull();
  });
});

describe("deployClock", () => {
  it("subtracts a finished wait from the working time", () => {
    const state = fold([
      { reason: "deploy-slot", ahead: 2, streamId: at(1_000) },
      { reason: null, streamId: at(61_000) },
    ]);
    const clock = deployClock(state, { startedAt: T0, now: T0 + 100_000, queued: false });
    expect(clock.wait).toBeNull();
    expect(clock.waitedMs).toBe(60_000);
    expect(clock.workingMs).toBe(40_000);
  });

  it("counts an open wait up to now", () => {
    const state = fold([{ reason: "build-slot", streamId: at(30_000) }]);
    const clock = deployClock(state, { startedAt: T0, now: T0 + 45_000, queued: false });
    expect(clock.wait?.reason).toBe("build-slot");
    expect(clock.waitedMs).toBe(15_000);
    expect(clock.workingMs).toBe(30_000);
  });

  it("adds up separate waits", () => {
    const state = fold([
      { reason: "app", streamId: at(0) },
      { reason: null, streamId: at(10_000) },
      { reason: "checkout", streamId: at(20_000) },
      { reason: null, streamId: at(25_000) },
      { reason: "build-slot", streamId: at(40_000) },
    ]);
    const clock = deployClock(state, { startedAt: T0, now: T0 + 50_000, queued: false });
    expect(clock.waitedMs).toBe(25_000);
    expect(clock.workingMs).toBe(25_000);
  });

  it("keeps the wait's start when only the queue position changes", () => {
    const state = fold([
      { reason: "deploy-slot", ahead: 3, streamId: at(0) },
      { reason: "deploy-slot", ahead: 1, streamId: at(20_000) },
    ]);
    expect(state.current).toEqual({ reason: "deploy-slot", ahead: 1, since: T0 });
    expect(deployClock(state, { startedAt: T0, now: T0 + 30_000, queued: false }).waitedMs).toBe(30_000);
  });

  it("closes one wait when another reason takes over", () => {
    const state = fold([
      { reason: "app", streamId: at(0) },
      { reason: "deploy-slot", ahead: 1, streamId: at(8_000) },
    ]);
    expect(state.closedMs).toBe(8_000);
    expect(state.current?.since).toBe(T0 + 8_000);
  });

  it("treats a queued row with no stream events as waiting since it started", () => {
    const clock = deployClock(NO_WAIT, { startedAt: T0, now: T0 + 12_000, queued: true });
    expect(clock.wait).toEqual({ reason: null, since: T0 });
    expect(clock.waitedMs).toBe(12_000);
    expect(clock.workingMs).toBe(0);
  });

  it("trusts the stream over a stale queued row", () => {
    const state = fold([
      { reason: "deploy-slot", streamId: at(0) },
      { reason: null, streamId: at(5_000) },
    ]);
    const clock = deployClock(state, { startedAt: T0, now: T0 + 9_000, queued: true });
    expect(clock.wait).toBeNull();
    expect(clock.workingMs).toBe(4_000);
  });

  it("never reports more waiting than time since start", () => {
    // A wait stamped before the row's start, as clock skew would make it.
    const state = fold([{ reason: "deploy-slot", streamId: at(-5_000) }]);
    const clock = deployClock(state, { startedAt: T0, now: T0 + 3_000, queued: false });
    expect(clock.waitedMs).toBe(3_000);
    expect(clock.workingMs).toBe(0);
  });

  it("doesn't count a replayed wait twice", () => {
    const events: WaitEvent[] = [
      { reason: "deploy-slot", streamId: at(0) },
      { reason: null, streamId: at(10_000) },
    ];
    const state = fold([...events, ...events]);
    expect(state.closedMs).toBe(10_000);
    expect(state.current).toBeNull();
  });

  it("orders events in the same millisecond by sequence", () => {
    const state = fold([
      { reason: "checkout", streamId: at(0, 1) },
      { reason: null, streamId: at(0, 0) },
    ]);
    expect(state.current?.reason).toBe("checkout");
  });

  it("ignores an end without a start", () => {
    const state = fold([{ reason: null, streamId: at(5_000) }]);
    expect(deployClock(state, { startedAt: T0, now: T0 + 9_000, queued: false }).workingMs).toBe(9_000);
  });
});

describe("deployWaitOf", () => {
  it("holds a queued row until the stream reports a stage", () => {
    expect(deployWaitOf({ wait: NO_WAIT, stages: {} }, "queued")?.reason).toBeNull();
    expect(deployWaitOf({ wait: NO_WAIT, stages: { clone: "running" } }, "queued")).toBeNull();
    expect(deployWaitOf({ wait: NO_WAIT, stages: {} }, "running")).toBeNull();
  });

  it("reports the open wait whatever the row says", () => {
    const wait = fold([{ reason: "build-slot", streamId: at(0) }]);
    expect(deployWaitOf({ wait, stages: { build: "running" } }, "running")?.reason).toBe("build-slot");
  });
});

describe("activeDeploy", () => {
  it("prefers the running deploy over one queued behind it", () => {
    const rows = [{ id: "new", status: "queued" }, { id: "now", status: "running" }, { id: "old", status: "success" }];
    expect(activeDeploy(rows)?.id).toBe("now");
  });

  it("takes the first in line when nothing runs", () => {
    const rows = [{ id: "second", status: "queued" }, { id: "first", status: "queued" }];
    expect(activeDeploy(rows)?.id).toBe("first");
    expect(activeDeploy([{ id: "x", status: "success" }])).toBeNull();
  });
});

describe("parseWaitEvent", () => {
  it("accepts the contract shape", () => {
    expect(parseWaitEvent({ deploymentId: "d", reason: "deploy-slot", ahead: 2, streamId: "1-0" })).toEqual({
      reason: "deploy-slot",
      ahead: 2,
      total: undefined,
      streamId: "1-0",
    });
    expect(parseWaitEvent({ reason: null, streamId: "1-0" })).toEqual({ reason: null, ahead: undefined, total: undefined, streamId: "1-0" });
    expect(parseWaitEvent({ reason: "deploy-slot", ahead: 1, total: 3, streamId: "1-0" })).toMatchObject({ ahead: 1, total: 3 });
    expect(parseWaitEvent({ reason: "worker", streamId: "1-0" })?.reason).toBe("worker");
  });

  it("rejects an unknown reason or a missing stream id", () => {
    expect(parseWaitEvent({ reason: "disk", streamId: "1-0" })).toBeNull();
    expect(parseWaitEvent({ reason: "app" })).toBeNull();
    expect(parseWaitEvent(null)).toBeNull();
  });
});

describe("row waits", () => {
  const row = (status: string, waitReason: string | null, waitingSince: string | null = null) => ({ status, waitReason, waitingSince });

  it("holds a queued row, and a running one only while it names a reason", () => {
    expect(rowHold(row("queued", null))).toEqual({ reason: null, since: null, queued: true });
    expect(rowHold(row("running", "build-slot", "2026-10-01T00:00:00.000Z"))).toEqual({
      reason: "build-slot",
      since: Date.parse("2026-10-01T00:00:00.000Z"),
      queued: false,
    });
    expect(rowHold(row("running", null))).toBeNull();
    expect(rowHold(row("success", "build-slot"))).toBeNull();
  });

  it("ignores a reason the UI doesn't know", () => {
    expect(rowHold(row("running", "disk"))).toBeNull();
    expect(rowHold(row("queued", "disk"))?.reason).toBeNull();
  });

  it("counts the queue from the row's place in line", () => {
    const hold = rowHold({ status: "queued", waitReason: "deploy-slot", waitingSince: null, waitAhead: 3, waitTotal: 5 });
    expect(hold).toMatchObject({ ahead: 3, total: 5 });
    expect(rowHold({ status: "queued", waitReason: "deploy-slot", waitAhead: 3 })).toMatchObject({ ahead: 3 });
    expect(rowHold({ status: "queued", waitReason: null, waitAhead: 3 })?.ahead).toBeUndefined();
  });

  it("uses the row's wait until the stream reports one", () => {
    const hold = { reason: "build-slot" as const, since: T0, queued: false };
    expect(seedWait(NO_WAIT, hold).current).toEqual({ reason: "build-slot", since: T0 });
    const heard = fold([{ reason: null, streamId: at(5_000) }]);
    expect(seedWait(heard, hold)).toBe(heard);
    expect(seedWait(NO_WAIT, { reason: null, since: null, queued: true })).toBe(NO_WAIT);
  });
});

describe("deployView", () => {
  type Wait = Parameters<typeof deployView>[0]["wait"];
  const view = (queued: boolean, wait: Wait, started = false, preparing = false) => deployView({ queued, wait, started, preparing });

  it("reads a held request as preparing", () => {
    expect(view(true, null, false, true)).toMatchObject({ word: "Preparing", label: "Preparing", tone: "neutral", held: "queued" });
  });

  it("marks only a missing worker amber", () => {
    expect(view(true, { reason: "worker" })).toMatchObject({ word: "Queued", label: "Queued", tone: "warn", why: "The worker is offline" });
    expect(view(true, { reason: "app" })).toMatchObject({ label: "Queued", tone: "neutral", why: "This app is already deploying" });
    expect(view(true, { reason: "exclusive" })).toMatchObject({ label: "Queued", tone: "neutral", why: "Vardo is updating" });
    expect(view(true, null)).toMatchObject({ word: "Queued", label: "Queued", tone: "neutral" });
  });

  it("places a deploy in the slot queue as X of Y", () => {
    expect(view(true, { reason: "deploy-slot", ahead: 2, total: 5 }).label).toBe("Queued (3 of 5)");
    expect(view(true, { reason: "deploy-slot", ahead: 2 }).label).toBe("Queued (3)");
    expect(view(true, { reason: "deploy-slot" }).label).toBe("Queued");
    // A total smaller than the place is stale; the place alone still holds.
    expect(view(true, { reason: "deploy-slot", ahead: 4, total: 2 }).label).toBe("Queued (5)");
  });

  it("keeps a deploy queued to build counted as deploying", () => {
    expect(view(false, { reason: "build-slot", ahead: 1, total: 3 }, true)).toMatchObject({
      word: "Deploying",
      label: "Queued to build (2 of 3)",
      tone: "neutral",
      held: "build",
    });
    expect(view(false, { reason: "checkout" }, true)).toMatchObject({ word: "Deploying", label: "Queued to clone", held: "clone" });
  });

  it("starts, then deploys", () => {
    expect(view(false, null, false)).toMatchObject({ word: "Starting", tone: "info" });
    expect(view(false, null, true)).toMatchObject({ word: "Deploying", label: "Deploying", tone: "info" });
  });

  it("never says waiting", () => {
    const reasons = ["app", "deploy-slot", "build-slot", "checkout", "worker", "exclusive", null] as const;
    for (const reason of reasons) {
      for (const queued of [true, false]) expect(view(queued, { reason, ahead: 0, total: 2 }, !queued).label).not.toMatch(/wait/i);
    }
  });
});

describe("deployCardText", () => {
  const working = { wait: null, waitedMs: 119_000, workingMs: 145_000 };

  it("gives the estimate with what's done so far and what was spent queued", () => {
    const text = deployCardText(view0(), working, { now: T0, typicalMs: 277_000, started: true });
    expect(text).toEqual({ line: "About 2m 12s left · last deploy took 4m 37s", meta: "2m 25s so far · queued 1m 59s first" });
  });

  it("owns the held step's line and time", () => {
    const held = { wait: { reason: "build-slot" as const, ahead: 1, total: 3, since: T0 - 168_000 }, waitedMs: 168_000, workingMs: 50_000 };
    const v = deployView({ queued: false, wait: held.wait, started: true });
    expect(deployCardText(v, held, { now: T0, typicalMs: 277_000, started: true })).toEqual({
      line: "Queued to build (2 of 3) · 2m 48s",
      meta: "50s so far",
    });
  });

  it("says when it's running long", () => {
    const late = { wait: null, waitedMs: 0, workingMs: 300_000 };
    expect(deployCardText(view0(), late, { now: T0, typicalMs: 277_000, started: true })).toEqual({
      line: "Taking longer than last time",
      meta: "5m 0s so far",
    });
  });

  function view0() {
    return deployView({ queued: false, wait: null, started: true });
  }
});
