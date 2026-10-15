import { beforeEach, describe, expect, it, vi } from "vitest";

// Alerts clearing a minute apart used to send an email each. The hold sends them as one notice.

const m = vi.hoisted(() => ({ emit: vi.fn(), emitConfirmed: vi.fn() }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit, emitConfirmed: m.emitConfirmed }));

const { holdResolved, sendHeldResolved, flushResolved, RESOLVED_QUIET_MS } = await import("@/lib/notifications/resolved-hold");
import type { ResolvedHoldStore, ResolvedItem } from "@/lib/notifications/resolved-hold";

const now = Date.parse("2026-10-15T04:30:00Z");

function item(about: string, severity: "warning" | "critical" = "warning"): ResolvedItem {
  return { type: "app.anomaly", about, severity, title: `${about} back to normal`, detail: "", firedAt: "2026-10-15T04:00:00.000Z", resolvedAt: "2026-10-15T04:25:00.000Z" };
}

/** Holds in memory; due once nothing new held for the quiet window. */
function memoryStore(): ResolvedHoldStore & { held: Map<string, { items: ResolvedItem[]; last: number }> } {
  const held = new Map<string, { items: ResolvedItem[]; last: number }>();
  return {
    held,
    hold: vi.fn(async (orgId: string, items: ResolvedItem[], at: number) => {
      held.set(orgId, { items: [...(held.get(orgId)?.items ?? []), ...items], last: at });
    }),
    orgs: vi.fn(async () => [...held.keys()]),
    take: vi.fn(async (orgId: string, at: number, force = false) => {
      const entry = held.get(orgId);
      if (!entry) return [];
      if (!force && at - entry.last < RESOLVED_QUIET_MS) return null;
      held.delete(orgId);
      return entry.items;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.emitConfirmed.mockResolvedValue(undefined);
});

describe("resolution hold", () => {
  it("sends resolutions held over several passes as one grouped notice, worst first", async () => {
    const store = memoryStore();
    for (const [i, about] of ["a1", "a2", "a3"].entries()) {
      await holdResolved("org1", [item(about, about === "a3" ? "critical" : "warning")], new Date(now + i * 60_000), store);
      expect(await flushResolved(now + i * 60_000 + 30_000, store)).toBe(0);
    }
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.emitConfirmed).not.toHaveBeenCalled();

    expect(await flushResolved(now + 2 * 60_000 + RESOLVED_QUIET_MS, store)).toBe(1);
    expect(m.emitConfirmed).toHaveBeenCalledTimes(1);
    const [org, event] = m.emitConfirmed.mock.calls[0];
    expect(org).toBe("org1");
    expect(event).toMatchObject({ type: "alert.resolved", title: "3 alerts resolved", grouped: true });
    expect(event.alerts.map((a: ResolvedItem) => a.about)).toEqual(["a3", "a1", "a2"]);
    expect(event.held).toBeUndefined();
  });

  it("keeps a lone resolution's incident on the notice, so email and Discord thread it", async () => {
    const store = memoryStore();
    const incident = { id: "inc_1", transition: "resolved" } as ResolvedItem["incident"];
    await holdResolved("org1", [{ ...item("a1"), incident }], new Date(now), store);
    await sendHeldResolved("org1", now, true, store);
    expect(m.emitConfirmed.mock.calls[0][1]).toMatchObject({ title: "Resolved: a1 back to normal", incident: { id: "inc_1" }, grouped: true });
  });

  it("sends at once when Redis can't hold, rather than dropping it", async () => {
    const store = memoryStore();
    vi.mocked(store.hold).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await holdResolved("org1", [item("a1")], new Date(now), store);
    expect(m.emit).toHaveBeenCalledWith("org1", expect.objectContaining({ type: "alert.resolved", grouped: true }));
  });

  it("holds the items again when the notice can't be written", async () => {
    const store = memoryStore();
    await holdResolved("org1", [item("a1"), item("a2")], new Date(now), store);
    m.emitConfirmed.mockRejectedValueOnce(new Error("stream down"));
    expect(await sendHeldResolved("org1", now, true, store)).toBe(false);
    expect(store.held.get("org1")?.items.map((i) => i.about)).toEqual(["a1", "a2"]);

    expect(await sendHeldResolved("org1", now + 1000, true, store)).toBe(true);
    expect(m.emitConfirmed.mock.calls[1][1].alerts).toHaveLength(2);
  });

  it("sends nothing when nothing is held", async () => {
    expect(await sendHeldResolved("org1", now, true, memoryStore())).toBe(false);
    expect(m.emitConfirmed).not.toHaveBeenCalled();
  });
});
