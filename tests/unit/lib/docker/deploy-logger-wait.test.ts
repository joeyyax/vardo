import { describe, it, expect, vi, beforeEach } from "vitest";

// A deploy's own waits: one stream entry per change, the row kept in step and the sweeper's clock paused while it waits.

const { addMock, recordMock, totalMock, clock } = vi.hoisted(() => ({
  addMock: vi.fn().mockResolvedValue("1-0"),
  recordMock: vi.fn().mockResolvedValue(undefined),
  totalMock: vi.fn().mockResolvedValue(undefined),
  clock: [] as string[],
}));

vi.mock("@/lib/stream/producer", () => ({ addDeployLog: addMock }));
vi.mock("@/lib/stream/deploy-expiry", () => ({ expireDeployStream: vi.fn() }));
vi.mock("@/lib/deploy/waiting", () => ({ recordWait: recordMock, recordQueueTotal: totalMock }));
vi.mock("@/lib/deploy/running-clock", () => ({
  pauseRunningClock: (id: string) => {
    clock.push(`pause:${id}`);
    return { resume: async () => void clock.push(`resume:${id}`) };
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { createDeployLogger } from "@/lib/docker/deploy-logger";

beforeEach(() => {
  vi.clearAllMocks();
  clock.length = 0;
});

describe("deploy logger waits", () => {
  it("writes each change once, records it on the row and pauses the clock for the whole wait", async () => {
    const l = createDeployLogger("d1");
    l.stage("build", "running");
    await l.wait("build-slot");
    await l.wait("build-slot", 2, 3);
    await l.wait("build-slot", 2, 3);
    await l.wait("build-slot", 1, 3);
    await l.wait(null);
    await l.wait(null);

    const waits = addMock.mock.calls.map(([, e]) => e).filter((e) => "wait" in e);
    expect(waits.map((e) => [e.wait, e.ahead, e.total, e.stage])).toEqual([
      ["build-slot", undefined, undefined, "build"],
      ["build-slot", 2, 3, "build"],
      ["build-slot", 1, 3, "build"],
      ["", undefined, undefined, "build"],
    ]);
    expect(recordMock.mock.calls).toEqual([
      ["d1", "build-slot", undefined, undefined, { restart: true }],
      ["d1", "build-slot", 2, 3, { restart: false }],
      ["d1", "build-slot", 1, 3, { restart: false }],
      ["d1", null, undefined, undefined, { restart: true }],
    ]);
    expect(clock).toEqual(["pause:d1", "resume:d1"]);
  });

  it("restarts the row's wait when the reason changes", async () => {
    const l = createDeployLogger("d2");
    await l.wait("checkout");
    await l.wait("build-slot");
    expect(recordMock.mock.calls.map(([, r, , , o]) => [r, o.restart])).toEqual([
      ["checkout", true],
      ["build-slot", true],
    ]);
    expect(clock).toEqual(["pause:d2"]);
  });

  it("writes the line's length to every row in it when only that moved", async () => {
    const l = createDeployLogger("d4");
    await l.wait("build-slot", 1, 2);
    await l.wait("build-slot", 1, 3);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(totalMock).toHaveBeenCalledWith("build-slot", 3);
    expect(addMock.mock.calls.at(-1)?.[1]).toMatchObject({ line: "[wait] build-slot (2 of 3)", ahead: 1, total: 3 });
  });

  it("keeps going when the row write fails", async () => {
    recordMock.mockRejectedValueOnce(new Error("db down"));
    const l = createDeployLogger("d3");
    await l.wait("checkout");
    await l.wait(null);
    expect(addMock).toHaveBeenCalledTimes(2);
  });
});
