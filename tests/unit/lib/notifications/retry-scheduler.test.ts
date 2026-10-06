import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Failed sends queue a retry in Redis. Nothing processed that queue after the
// scheduler start was dropped, so the scheduler now starts with notifications
// and first clears out retries too old to be worth sending.

const { list, locks, send, logs } = vi.hoisted(() => ({
  list: [] as string[],
  locks: new Set<string>(),
  send: vi.fn(),
  logs: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    llen: vi.fn(async () => list.length),
    lpush: vi.fn(async (_k: string, ...v: string[]) => {
      for (const x of v) list.unshift(x);
      return list.length;
    }),
    rpop: vi.fn(async () => list.pop() ?? null),
    ltrim: vi.fn(async (_k: string, start: number, stop: number) => {
      list.splice(stop + 1);
      list.splice(0, start);
    }),
    set: vi.fn(async (key: string) => {
      if (locks.has(key)) return null;
      locks.add(key);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (locks.delete(key) ? 1 : 0)),
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      notificationChannels: {
        findFirst: vi.fn(async () => ({ id: "ch-1", name: "Ops", type: "webhook", enabled: true })),
      },
    },
    insert: () => ({ values: async (v: Record<string, unknown>) => void logs.push(v) }),
  },
}));
vi.mock("@/lib/notifications/factory", () => ({ createChannel: () => ({ send }) }));

import { enqueueRetry, dropStaleRetries, tickNotificationRetries } from "@/lib/notifications/retry";
import {
  startNotificationRetryScheduler,
  stopNotificationRetryScheduler,
  STALE_RETRY_MS,
} from "@/lib/notifications/scheduler";

const base = { orgId: "org-1", channelId: "ch-1", channelName: "Ops", channelType: "webhook", event: { type: "deploy.failed" } };
const queued = (retryAfter: number, attempt = 1) => JSON.stringify({ ...base, attempt, retryAfter });

beforeEach(() => {
  vi.clearAllMocks();
  list.length = 0;
  locks.clear();
  logs.length = 0;
  send.mockResolvedValue(undefined);
});

afterEach(() => {
  stopNotificationRetryScheduler();
  vi.useRealTimers();
});

describe("dropStaleRetries", () => {
  it("drops retries due more than the cutoff ago and keeps the rest in order", async () => {
    const now = Date.now();
    const fresh1 = queued(now - 60_000);
    const fresh2 = queued(now + 5_000);
    list.push(fresh2, queued(now - 2 * 60 * 60_000), fresh1, "not json");

    expect(await dropStaleRetries(STALE_RETRY_MS)).toBe(2);
    expect(list).toEqual([fresh2, fresh1]);
    expect(locks.size).toBe(0);
  });

  it("leaves the queue alone while another worker holds the lock", async () => {
    list.push(queued(0));
    locks.add("lock:notification-retry");

    expect(await dropStaleRetries(STALE_RETRY_MS)).toBe(0);
    expect(list).toHaveLength(1);
  });
});

describe("tickNotificationRetries", () => {
  it("retries a fresh failure", async () => {
    await enqueueRetry(base as Parameters<typeof enqueueRetry>[0], 0);

    await tickNotificationRetries();

    expect(send).toHaveBeenCalledWith(base.event);
    expect(logs.map((l) => l.status)).toEqual(["success"]);
    expect(list).toEqual([]);
    expect(locks.size).toBe(0);
  });

  it("does nothing while another worker holds the lock", async () => {
    await enqueueRetry(base as Parameters<typeof enqueueRetry>[0], 0);
    locks.add("lock:notification-retry");

    await tickNotificationRetries();

    expect(send).not.toHaveBeenCalled();
  });
});

describe("startNotificationRetryScheduler", () => {
  it("clears stale retries before the first tick, then retries fresh ones", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    list.push(queued(Date.now() - 2 * 60 * 60_000));

    await startNotificationRetryScheduler();
    expect(list).toEqual([]);

    await enqueueRetry(base as Parameters<typeof enqueueRetry>[0], 0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("starts once per process", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await startNotificationRetryScheduler();
    await startNotificationRetryScheduler();

    expect(vi.getTimerCount()).toBe(1);
  });
});
