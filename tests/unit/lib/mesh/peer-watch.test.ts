import { beforeEach, describe, expect, it, vi } from "vitest";

const { peers, sync, watches } = vi.hoisted(() => ({
  peers: { value: [] as Record<string, unknown>[] },
  sync: vi.fn(async () => "unchanged" as const),
  watches: { ids: new Set<string>() },
}));

vi.mock("@/lib/db", () => ({ db: { query: { meshPeers: { findMany: vi.fn(async () => peers.value) } } } }));
vi.mock("@/lib/incidents/host", () => ({ syncHostProblem: sync }));
vi.mock("@/lib/uptime/client", () => ({ uptimeClient: { watchesPeer: async (id: string) => watches.ids.has(id) } }));

import { judgePeer, peerWatchLoop } from "@/lib/mesh/peer-watch";

const now = new Date("2026-10-10T12:00:00Z");
const ago = (s: number, from = now) => new Date(from.getTime() - s * 1000);

describe("judgePeer", () => {
  it("is silent after five minutes without an answer", () => {
    expect(judgePeer({ lastSeenAt: ago(290), consoleAt: null, workerAt: null, watchdogAt: null }, now).silent).toBe(false);
    expect(judgePeer({ lastSeenAt: ago(310), consoleAt: null, workerAt: null, watchdogAt: null }, now).silent).toBe(true);
  });

  it("never calls a peer that hasn't answered yet silent", () => {
    expect(judgePeer({ lastSeenAt: null, consoleAt: null, workerAt: null, watchdogAt: null }, now).silent).toBe(false);
  });

  it("judges the worker and watchdog against the peer's own console clock", () => {
    // The peer's clock runs an hour behind; only the gaps on its clock count.
    const peerNow = ago(3600);
    const v = judgePeer({ lastSeenAt: ago(20), consoleAt: peerNow, workerAt: ago(200, peerNow), watchdogAt: ago(30, peerNow) }, now);
    expect(v).toEqual({ silent: false, workerDown: true, watchdogSilent: false });
    const w = judgePeer({ lastSeenAt: ago(20), consoleAt: peerNow, workerAt: ago(20, peerNow), watchdogAt: ago(700, peerNow) }, now);
    expect(w).toEqual({ silent: false, workerDown: false, watchdogSilent: true });
  });

  it("leaves worker and watchdog undecided for a silent peer or one that sends no heartbeats", () => {
    expect(judgePeer({ lastSeenAt: ago(600), consoleAt: ago(600), workerAt: ago(9000), watchdogAt: null }, now)).toEqual({
      silent: true,
      workerDown: null,
      watchdogSilent: null,
    });
    expect(judgePeer({ lastSeenAt: ago(10), consoleAt: null, workerAt: null, watchdogAt: null }, now).workerDown).toBeNull();
  });
});

describe("peer-watch pass", () => {
  beforeEach(() => {
    sync.mockClear();
    watches.ids.clear();
  });

  it("raises each problem for the peer and skips the undecided ones", async () => {
    const t = new Date();
    peers.value = [
      { id: "p-1", instanceId: "i-1", name: "edge", lastSeenAt: new Date(t.getTime() - 10 * 60_000), consoleAt: t, workerAt: t, watchdogAt: t },
      { id: "p-2", instanceId: "i-2", name: "core", lastSeenAt: t, consoleAt: t, workerAt: new Date(t.getTime() - 5 * 60_000), watchdogAt: t },
    ];
    await peerWatchLoop.tick();
    const calls = (sync.mock.calls as unknown as [{ kind: string; about: string }, boolean][]).map(([p, active]) => [p.about, p.kind, active]);
    expect(calls).toEqual([
      ["peer:i-1", "host.peer-silent", true],
      ["peer:i-2", "host.peer-silent", false],
      ["peer:i-2", "host.peer-worker-down", true],
      ["peer:i-2", "host.peer-watchdog-silent", false],
    ]);
  });

  it("leaves a silent peer to uptime when uptime watches it, so there is one alert", async () => {
    const t = new Date();
    peers.value = [{ id: "p-1", instanceId: "i-1", name: "edge", lastSeenAt: new Date(t.getTime() - 10 * 60_000), consoleAt: null, workerAt: null, watchdogAt: null }];
    watches.ids.add("p-1");
    await peerWatchLoop.tick();
    const calls = (sync.mock.calls as unknown as [{ kind: string; about: string }, boolean][]).map(([p, active]) => [p.kind, active]);
    expect(calls).toEqual([["host.peer-silent", false]]);
  });
});
