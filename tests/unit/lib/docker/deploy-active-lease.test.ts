import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// deploy:active:{appId} is a lease, not a fixed TTL
//
// A self-deploy stops its own container between the success write and the
// release, so the entry outlived the deploy by its full 30-minute TTL. The next
// deploy of that app found it, could not cancel a swap-stage owner, and waited
// out the whole two-minute poll before starting.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const clock = { now: 0 };
  return {
    store,
    clock,
    redis: {
      async get(key: string) {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= clock.now) {
          store.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key: string, value: string, _px: string, ttl: number) {
        store.set(key, { value, expiresAt: clock.now + ttl });
        return "OK";
      },
      async del(key: string) {
        store.delete(key);
      },
    },
  };
});

vi.mock("@/lib/redis", () => ({ redis: fake.redis }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: vi.fn(),
  runDeployment: vi.fn(),
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn(),
  waitForConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  removeFromQueue: vi.fn(),
  getConcurrencyLimit: () => 1,
}));

import {
  ACTIVE_HEARTBEAT_MS,
  ACTIVE_TTL_MS,
  renewActiveLease,
} from "@/lib/docker/deploy-cancel";

const KEY = "deploy:active:app-1";

function hold(deploymentId: string) {
  fake.store.set(KEY, {
    value: JSON.stringify({ deploymentId, stage: "build" }),
    expiresAt: fake.clock.now + ACTIVE_TTL_MS,
  });
}

describe("the active-deploy lease", () => {
  beforeEach(() => {
    fake.store.clear();
    fake.clock.now = 0;
  });

  it("drops a dead owner inside a minute", () => {
    expect(ACTIVE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("renews often enough to survive two missed beats", () => {
    expect(ACTIVE_HEARTBEAT_MS * 3).toBeLessThanOrEqual(ACTIVE_TTL_MS);
  });

  it("extends the lease of the deploy that holds it", async () => {
    hold("deploy-1");
    fake.clock.now = ACTIVE_TTL_MS - 1;

    await renewActiveLease("app-1", "deploy-1", "healthcheck");

    expect(fake.store.get(KEY)!.expiresAt).toBe(fake.clock.now + ACTIVE_TTL_MS);
    expect(await fake.redis.get(KEY)).toContain("healthcheck");
  });

  it("expires once nothing renews it", async () => {
    hold("deploy-1");
    fake.clock.now = ACTIVE_TTL_MS;

    expect(await fake.redis.get(KEY)).toBeNull();
  });

  it("does not resurrect a lease that already lapsed", async () => {
    hold("deploy-1");
    fake.clock.now = ACTIVE_TTL_MS;

    await renewActiveLease("app-1", "deploy-1", "cleanup");

    expect(await fake.redis.get(KEY)).toBeNull();
  });

  it("leaves a lease a newer deploy has taken", async () => {
    hold("deploy-2");

    await renewActiveLease("app-1", "deploy-1", "clone");

    const held = JSON.parse((await fake.redis.get(KEY))!) as { deploymentId: string };
    expect(held.deploymentId).toBe("deploy-2");
  });
});
