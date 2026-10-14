import { describe, it, expect } from "vitest";
import {
  aboutMinutes,
  activeDeploy,
  applyWait,
  deployClock,
  deployWaitOf,
  deployCardText,
  deployView,
  lineLabel,
  NO_WAIT,
  ordinal,
  queuedRowLabel,
  queuedStep,
  parseWaitEvent,
  rowHold,
  seedWait,
  streamIdMs,
  streamView,
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
      eta: undefined,
      streamId: "1-0",
    });
    expect(parseWaitEvent({ reason: null, streamId: "1-0" })).toEqual({ reason: null, ahead: undefined, total: undefined, eta: undefined, streamId: "1-0" });
    expect(parseWaitEvent({ reason: "deploy-slot", ahead: 1, total: 3, streamId: "1-0" })).toMatchObject({ ahead: 1, total: 3 });
    expect(parseWaitEvent({ reason: "worker", streamId: "1-0" })?.reason).toBe("worker");
  });

  it("reads the estimate as a time, and drops one that isn't", () => {
    expect(parseWaitEvent({ reason: "deploy-slot", eta: "2026-10-14T20:00:00.000Z", streamId: "1-0" })?.eta).toBe(Date.parse("2026-10-14T20:00:00.000Z"));
    expect(parseWaitEvent({ reason: "deploy-slot", eta: "soon", streamId: "1-0" })?.eta).toBeUndefined();
  });

  it("keeps the latest estimate as the place in line moves", () => {
    const state = fold([
      { reason: "deploy-slot", ahead: 2, eta: T0 + 360_000, streamId: at(0) },
      { reason: "deploy-slot", ahead: 1, eta: T0 + 200_000, streamId: at(60_000) },
    ]);
    expect(state.current).toEqual({ reason: "deploy-slot", ahead: 1, total: undefined, eta: T0 + 200_000, since: T0 });
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

  it("carries the row's estimate while it names a reason", () => {
    const eta = "2026-10-14T20:00:00.000Z";
    expect(rowHold({ status: "queued", waitReason: "deploy-slot", waitEta: eta })?.eta).toBe(Date.parse(eta));
    expect(rowHold({ status: "queued", waitReason: null, waitEta: eta })?.eta).toBeUndefined();
    const hold = { reason: "deploy-slot" as const, eta: Date.parse(eta), since: T0, queued: true };
    expect(seedWait(NO_WAIT, hold).current?.eta).toBe(Date.parse(eta));
  });

  it("uses the row's wait until the stream reports one", () => {
    const hold = { reason: "build-slot" as const, since: T0, queued: false };
    expect(seedWait(NO_WAIT, hold).current).toEqual({ reason: "build-slot", since: T0 });
    const heard = fold([{ reason: null, streamId: at(5_000) }]);
    expect(seedWait(heard, hold)).toBe(heard);
    expect(seedWait(NO_WAIT, { reason: null, since: null, queued: true })).toBe(NO_WAIT);
  });
});

describe("ordinal", () => {
  it("reads places the way people say them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th",
    ]);
  });
});

describe("aboutMinutes", () => {
  it("rounds to whole minutes, and says less than a minute under one", () => {
    expect(aboutMinutes(59_999)).toBe("less than a minute");
    expect(aboutMinutes(-5_000)).toBe("less than a minute");
    expect(aboutMinutes(60_000)).toBe("about 1 min");
    expect(aboutMinutes(5.5 * 60_000)).toBe("about 6 min");
  });
});

describe("lineLabel", () => {
  const now = T0;
  const in6 = now + 6 * 60_000;

  it("gives the deploy line's estimate and place", () => {
    expect(lineLabel("deploy", { ahead: 2, eta: in6 }, now)).toBe("Starts in about 6 min · 3rd in line");
    expect(lineLabel("deploy", { ahead: 0, eta: in6 }, now)).toBe("Starts next");
    expect(lineLabel("deploy", { ahead: 2 }, now)).toBe("3rd in line");
    expect(lineLabel("deploy", { ahead: 0 }, now)).toBe("Next in line");
    expect(lineLabel("deploy", { eta: in6 }, now)).toBe("Starts in about 6 min");
    expect(lineLabel("deploy", {}, now)).toBe("Queued");
  });

  it("gives the build line's estimate and place", () => {
    expect(lineLabel("build", { ahead: 1, eta: now + 4 * 60_000 }, now)).toBe("Build starts in about 4 min · 2nd in line");
    expect(lineLabel("build", { ahead: 0, eta: in6 }, now)).toBe("Building next");
    expect(lineLabel("build", { ahead: 1 }, now)).toBe("2nd in line to build");
    expect(lineLabel("build", { ahead: 0 }, now)).toBe("Next to build");
    expect(lineLabel("build", {}, now)).toBe("Queued to build");
  });

  it("counts the estimate down, and drops it before the clock is known", () => {
    expect(lineLabel("deploy", { ahead: 2, eta: in6 }, now + 5 * 60_000)).toBe("Starts in about 1 min · 3rd in line");
    expect(lineLabel("deploy", { ahead: 2, eta: in6 }, now + 7 * 60_000)).toBe("Starts in less than a minute · 3rd in line");
    expect(lineLabel("deploy", { ahead: 2, eta: in6 }, null)).toBe("3rd in line");
  });
});

describe("queuedRowLabel", () => {
  it("places a deploy behind this app's own by its order in the list", () => {
    expect(queuedRowLabel({ reason: "app", since: T0, queued: true }, 1, T0)).toBe("Next in line");
    expect(queuedRowLabel(null, 3, T0)).toBe("3rd in line");
  });

  it("uses the deploy line's place when the row has one", () => {
    expect(queuedRowLabel({ reason: "deploy-slot", ahead: 4, since: T0, queued: true }, 1, T0)).toBe("5th in line");
  });
});

describe("deployView", () => {
  type Wait = Parameters<typeof deployView>[0]["wait"];
  const view = (queued: boolean, wait: Wait, started = false, preparing = false) => deployView({ queued, wait, started, preparing, now: T0 });

  it("reads a held request as preparing", () => {
    expect(view(true, null, false, true)).toMatchObject({ word: "Preparing", label: "Preparing", tone: "neutral", held: "queued" });
  });

  it("marks only a missing worker amber", () => {
    expect(view(true, { reason: "worker" })).toMatchObject({ word: "Queued", label: "Queued", tone: "warn", why: "The worker is offline" });
    expect(view(true, { reason: "app" })).toMatchObject({ label: "Queued", tone: "neutral", why: "This app is already deploying" });
    expect(view(true, { reason: "exclusive" })).toMatchObject({ label: "Queued", tone: "neutral", why: "Vardo is updating" });
    expect(view(true, null)).toMatchObject({ word: "Queued", label: "Queued", tone: "neutral" });
  });

  it("names a deploy's place in the deploy line", () => {
    expect(view(true, { reason: "deploy-slot", ahead: 2, total: 5, eta: T0 + 6 * 60_000 })).toMatchObject({
      word: "Queued",
      label: "Starts in about 6 min · 3rd in line",
      tone: "neutral",
    });
    expect(view(true, { reason: "deploy-slot", ahead: 0 }).label).toBe("Next in line");
  });

  it("keeps a deploy in the build line counted as deploying", () => {
    expect(view(false, { reason: "build-slot", ahead: 1, total: 3 }, true)).toMatchObject({
      word: "Deploying",
      label: "2nd in line to build",
      tone: "neutral",
      held: "build",
    });
  });

  it("calls a checkout wait plain queued, with the reason on hover", () => {
    expect(view(false, { reason: "checkout" }, true)).toMatchObject({
      word: "Deploying",
      label: "Queued",
      why: "Another deploy of this app is using its checkout",
      held: "clone",
    });
  });

  it("starts, then deploys", () => {
    expect(view(false, null, false)).toMatchObject({ word: "Starting", tone: "info" });
    expect(view(false, null, true)).toMatchObject({ word: "Deploying", label: "Deploying", tone: "info" });
  });

  it("never says waiting or shows a total", () => {
    const reasons = ["app", "deploy-slot", "build-slot", "checkout", "worker", "exclusive", null] as const;
    for (const reason of reasons) {
      for (const queued of [true, false]) {
        const label = view(queued, { reason, ahead: 1, total: 9 }, !queued).label;
        expect(label).not.toMatch(/wait/i);
        expect(label).not.toMatch(/9/);
      }
    }
  });
});

describe("streamView", () => {
  it("reads a claimed row with no phase as starting, and one with a phase as deploying", () => {
    expect(streamView({ wait: NO_WAIT, stages: {} }, { status: "running", stage: null }).word).toBe("Starting");
    expect(streamView({ wait: NO_WAIT, stages: {} }, { status: "running", stage: "clone" }).word).toBe("Deploying");
    expect(streamView({ wait: NO_WAIT, stages: {} }, { status: "queued", stage: null }).word).toBe("Queued");
  });
});

describe("queuedStep", () => {
  it("names the step by the word until work starts, then ticks it off", () => {
    const at = (queued: boolean, wait: Parameters<typeof deployView>[0]["wait"], started: boolean) => queuedStep(deployView({ queued, wait, started }));
    expect(at(true, { reason: "deploy-slot", ahead: 2 }, false)).toEqual({ label: "Queued", state: "held" });
    expect(at(false, null, false)).toEqual({ label: "Starting", state: "now" });
    expect(at(false, { reason: "build-slot", ahead: 1 }, true)).toEqual({ label: "Queued", state: "done" });
  });
});

describe("deployCardText", () => {
  const working = { wait: null, waitedMs: 119_000, workingMs: 145_000 };

  it("gives the estimate, then what's done, what was spent queued and the last deploy", () => {
    expect(deployCardText(view0(), working, 277_000)).toEqual({
      line: "About 2m 12s left",
      meta: "2m 25s so far · queued 1m 59s first · last deploy took 4m 37s",
    });
  });

  it("shows only the line while it waits, with no elapsed time", () => {
    const held = { wait: { reason: "build-slot" as const, ahead: 1, total: 3, since: T0 - 168_000 }, waitedMs: 168_000, workingMs: 50_000 };
    const v = deployView({ queued: false, wait: held.wait, started: true });
    expect(deployCardText(v, held, 277_000)).toEqual({ line: "2nd in line to build", meta: null });
  });

  it("says when it's running long, or that there's nothing to judge by", () => {
    const late = { wait: null, waitedMs: 0, workingMs: 300_000 };
    expect(deployCardText(view0(), late, 277_000)).toEqual({
      line: "Taking longer than last time",
      meta: "5m 0s so far · last deploy took 4m 37s",
    });
    expect(deployCardText(view0(), late, null)).toEqual({ line: "No earlier deploy to judge by", meta: "5m 0s so far" });
  });

  function view0() {
    return deployView({ queued: false, wait: null, started: true });
  }
});
