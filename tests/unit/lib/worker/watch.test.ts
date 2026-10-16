import { beforeEach, describe, expect, it, vi } from "vitest";

const { hb, sync } = vi.hoisted(() => ({
  hb: { workerAt: null as Date | null, watchdogAt: null as Date | null, now: new Date() },
  sync: vi.fn(async () => "unchanged" as const),
}));

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => [{ at: null }]) } }));
vi.mock("@/lib/incidents/host", () => ({ syncHostProblem: sync }));
vi.mock("@/lib/worker/presence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worker/presence")>()),
  pruneWorkers: async () => 0,
  readWorkers: async () => ({
    now: hb.now,
    rows: hb.workerAt ? [{ heartbeatAt: hb.workerAt, readyAt: hb.workerAt, drainingAt: null }] : [],
  }),
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, stat: async () => (hb.watchdogAt ? { mtime: hb.watchdogAt } : Promise.reject(new Error("ENOENT"))) };
});

import { watchdogSilent, workerDown, workerWatchPass } from "@/lib/worker/watch";

const now = new Date("2026-10-10T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("worker-down", () => {
  it("opens after three minutes without a heartbeat", () => {
    expect(workerDown(ago(170), now, ago(3600))).toBe(false);
    expect(workerDown(ago(181), now, ago(3600))).toBe(true);
  });

  it("counts a never-seen worker from web's boot, so a fresh install doesn't alert at once", () => {
    expect(workerDown(null, now, ago(60))).toBe(false);
    expect(workerDown(null, now, ago(200))).toBe(true);
  });
});

describe("watchdog-silent", () => {
  it("opens when the alive file is older than ten minutes, never when it's missing", () => {
    expect(watchdogSilent(null, now)).toBe(false);
    expect(watchdogSilent(ago(590), now)).toBe(false);
    expect(watchdogSilent(ago(610), now)).toBe(true);
  });
});

describe("worker-watch pass", () => {
  beforeEach(() => {
    sync.mockClear();
    vi.stubEnv("VARDO_LOOPS_IN_WEB", "auto");
  });

  it("raises host.worker-down and host.watchdog-silent while each holds, and clears them on recovery", async () => {
    hb.now = new Date();
    hb.workerAt = new Date(Date.now() - 10 * 60_000);
    hb.watchdogAt = new Date(Date.now() - 20 * 60_000);
    await workerWatchPass();
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ kind: "host.worker-down", about: "host" }), true, expect.any(String));
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ kind: "host.watchdog-silent", about: "host" }), true, expect.any(String));

    sync.mockClear();
    hb.workerAt = new Date();
    hb.watchdogAt = new Date();
    await workerWatchPass();
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ kind: "host.worker-down" }), false, expect.any(String));
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ kind: "host.watchdog-silent" }), false, expect.any(String));
  });

  it("doesn't look for a worker when web runs every loop", async () => {
    vi.stubEnv("VARDO_LOOPS_IN_WEB", "always");
    await workerWatchPass();
    expect(sync).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "host.worker-down" }), expect.anything(), expect.anything());
  });
});
