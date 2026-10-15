// The resolution hold against a real Redis: the quiet window, the cap, a restart and two flushers at once.
// Skips without a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

const m = vi.hoisted(() => ({ emit: vi.fn(), emitConfirmed: vi.fn() }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit, emitConfirmed: m.emitConfirmed }));

const { resolvedHoldStore, holdResolved, flushResolved, sendHeldResolved, RESOLVED_QUIET_MS, RESOLVED_MAX_MS } = await import(
  "@/lib/notifications/resolved-hold"
);
import type { ResolvedItem } from "@/lib/notifications/resolved-hold";

async function connect(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const client = await connect();

const MIN = 60_000;
const start = Date.parse("2026-10-15T04:25:00Z");

function item(about: string, at: number): ResolvedItem {
  return { type: "app.anomaly", about, severity: "warning", title: `${about} back to normal`, detail: "", firedAt: new Date(start - 30 * MIN).toISOString(), resolvedAt: new Date(at).toISOString() };
}

describe.skipIf(!client)("resolution hold on Redis", () => {
  const prefix = `test:resolved-hold:${process.pid}:${Date.now()}`;
  const store = resolvedHoldStore(client! as never, prefix);

  async function clean(): Promise<void> {
    const keys = await client!.keys(`${prefix}:*`);
    if (keys.length > 0) await client!.del(...keys);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    m.emitConfirmed.mockResolvedValue(undefined);
    await clean();
  });

  afterAll(async () => {
    await clean();
    client!.disconnect();
  });

  it("sends one notice for alerts clearing a minute apart, once they stop", async () => {
    // 04:25 to 04:30, one clear a minute, as on Long House.
    for (let i = 0; i <= 5; i++) {
      const at = start + i * MIN;
      await holdResolved("org1", [item(`a${i}`, at)], new Date(at), store);
      expect(await flushResolved(at + 30_000, store)).toBe(0);
    }
    expect(m.emitConfirmed).not.toHaveBeenCalled();

    const last = start + 5 * MIN;
    expect(await flushResolved(last + RESOLVED_QUIET_MS - 1, store)).toBe(0);
    expect(await flushResolved(last + RESOLVED_QUIET_MS, store)).toBe(1);
    expect(m.emitConfirmed).toHaveBeenCalledTimes(1);
    expect(m.emitConfirmed.mock.calls[0][1]).toMatchObject({ title: "6 alerts resolved", grouped: true });
    expect(m.emitConfirmed.mock.calls[0][1].alerts).toHaveLength(6);

    expect(await flushResolved(last + 2 * RESOLVED_QUIET_MS, store)).toBe(0);
    expect(await store.orgs()).toEqual([]);
  });

  it("sends by the cap while alerts keep clearing", async () => {
    let sentAt: number | null = null;
    for (let at = start; at <= start + 20 * MIN && sentAt === null; at += MIN) {
      await holdResolved("org1", [item(`a${at}`, at)], new Date(at), store);
      if ((await flushResolved(at, store)) > 0) sentAt = at;
    }
    expect(sentAt).toBe(start + RESOLVED_MAX_MS);
    expect(m.emitConfirmed.mock.calls[0][1].alerts).toHaveLength(RESOLVED_MAX_MS / MIN + 1);
  });

  it("keeps held resolutions across a restart", async () => {
    await holdResolved("org1", [item("a1", start)], new Date(start), store);
    const restarted = resolvedHoldStore(client! as never, prefix);
    expect(await flushResolved(start + RESOLVED_QUIET_MS, restarted)).toBe(1);
    expect(m.emitConfirmed.mock.calls[0][1].alerts.map((a: ResolvedItem) => a.about)).toEqual(["a1"]);
  });

  it("sends once when two processes flush together", async () => {
    await holdResolved("org1", [item("a1", start), item("a2", start)], new Date(start), store);
    const other = resolvedHoldStore(client! as never, prefix);
    const at = start + RESOLVED_QUIET_MS;
    const sent = await Promise.all([flushResolved(at, store), flushResolved(at, other), sendHeldResolved("org1", at, true, other)]);
    expect(sent.reduce<number>((n, s) => n + Number(s), 0)).toBe(1);
    expect(m.emitConfirmed).toHaveBeenCalledTimes(1);
  });

  it("keeps orgs apart and sends a forced org at once", async () => {
    await holdResolved("org1", [item("a1", start)], new Date(start), store);
    await holdResolved("org2", [item("b1", start)], new Date(start), store);
    expect(await sendHeldResolved("org1", start, true, store)).toBe(true);
    expect(m.emitConfirmed.mock.calls[0][0]).toBe("org1");
    expect(await store.orgs()).toEqual(["org2"]);
  });
});
