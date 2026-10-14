import { describe, it, expect } from "vitest";
import {
  applyWait,
  deployClock,
  deployWaitOf,
  NO_WAIT,
  parseWaitEvent,
  streamIdMs,
  waitLabel,
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

describe("parseWaitEvent", () => {
  it("accepts the contract shape", () => {
    expect(parseWaitEvent({ deploymentId: "d", reason: "deploy-slot", ahead: 2, streamId: "1-0" })).toEqual({
      reason: "deploy-slot",
      ahead: 2,
      streamId: "1-0",
    });
    expect(parseWaitEvent({ reason: null, streamId: "1-0" })).toEqual({ reason: null, ahead: undefined, streamId: "1-0" });
  });

  it("rejects an unknown reason or a missing stream id", () => {
    expect(parseWaitEvent({ reason: "disk", streamId: "1-0" })).toBeNull();
    expect(parseWaitEvent({ reason: "app" })).toBeNull();
    expect(parseWaitEvent(null)).toBeNull();
  });
});

describe("waitLabel", () => {
  it("counts the deploys ahead in the queue", () => {
    expect(waitLabel("deploy-slot", 2)).toBe("Queued behind 2 other deploys");
    expect(waitLabel("deploy-slot", 1)).toBe("Queued behind 1 other deploy");
    expect(waitLabel("deploy-slot", 0)).toBe("Queued for a deploy slot");
    expect(waitLabel("deploy-slot")).toBe("Queued for a deploy slot");
  });

  it("names what each wait is for", () => {
    expect(waitLabel("app")).toBe("Queued behind this app's running deploy");
    expect(waitLabel("build-slot")).toBe("Waiting for the builder");
    expect(waitLabel("build-slot", 1)).toBe("Waiting for the builder, 1 build ahead");
    expect(waitLabel("checkout")).toBe("Waiting for another deploy's checkout");
    expect(waitLabel(null)).toBe("Queued");
  });
});
