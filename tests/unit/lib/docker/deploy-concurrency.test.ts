import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories — vi.mock is hoisted above imports, so mock state
// must be defined with vi.hoisted() to be accessible in the factory.
// ---------------------------------------------------------------------------

const { redisState, redisList, redisMock } = vi.hoisted(() => {
  const redisState: Record<string, string> = {};
  const redisList: Record<string, string[]> = {};

  const redisMock = {
    get: vi.fn(async (key: string) => redisState[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisState[key] = value;
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const had = key in redisState;
      delete redisState[key];
      return had ? 1 : 0;
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      if (!redisList[key]) redisList[key] = [];
      redisList[key].push(value);
      return redisList[key].length;
    }),
    lpop: vi.fn(async (key: string) => {
      if (!redisList[key] || redisList[key].length === 0) return null;
      return redisList[key].shift()!;
    }),
    lindex: vi.fn(async (key: string, index: number) => {
      const list = redisList[key] ?? [];
      if (index < 0) index = list.length + index;
      return list[index] ?? null;
    }),
    llen: vi.fn(async (key: string) => (redisList[key] ?? []).length),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = redisList[key] ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
    lrem: vi.fn(async (key: string, _count: number, value: string) => {
      if (!redisList[key]) return 0;
      const before = redisList[key].length;
      redisList[key] = redisList[key].filter((v) => v !== value);
      return before - redisList[key].length;
    }),
    // Inline Lua simulation: handles LUA_TRY_ADVANCE and LUA_RELEASE
    eval: vi.fn(
      async (
        script: string,
        numKeys: number,
        ...rest: (string | number)[]
      ): Promise<number> => {
        const keys = rest.slice(0, numKeys) as string[];
        const argv = rest.slice(numKeys) as string[];

        if (script.includes("lindex")) {
          // LUA_TRY_ADVANCE
          const [queueKey, activeKey] = keys;
          const deploymentId = argv[0];
          const limit = parseInt(argv[1], 10);

          const list = redisList[queueKey] ?? [];
          const head = list[0] ?? null;
          if (head !== deploymentId) return 0;

          const active = parseInt(redisState[activeKey] ?? "0", 10);
          if (active >= limit) return 0;

          redisList[queueKey] = list.slice(1);
          redisState[activeKey] = String(active + 1);
          return 1;
        }

        if (script.includes("tostring(active - 1)")) {
          // LUA_RELEASE
          const [activeKey] = keys;
          const active = parseInt(redisState[activeKey] ?? "0", 10);
          if (active > 0) {
            redisState[activeKey] = String(active - 1);
            return active - 1;
          }
          return 0;
        }

        return 0;
      },
    ),
  };

  return { redisState, redisList, redisMock };
});

vi.mock("@/lib/redis", () => ({ redis: redisMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import {
  enqueueAndTryAcquire,
  waitForConcurrencySlot,
  releaseConcurrencySlot,
  removeFromQueue,
  getConcurrencyState,
  reconcileActiveCounter,
  reconcileQueue,
  getConcurrencyLimit,
  ACTIVE_KEY,
  QUEUE_KEY,
} from "@/lib/docker/deploy-concurrency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  for (const k of Object.keys(redisState)) delete redisState[k];
  for (const k of Object.keys(redisList)) delete redisList[k];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy-concurrency", () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    delete process.env.VARDO_MAX_DEPLOY_CONCURRENCY;
  });

  describe("enqueueAndTryAcquire", () => {
    it("acquires immediately when no other deploys are running", async () => {
      const acquired = await enqueueAndTryAcquire("deploy-1");
      expect(acquired).toBe(true);
      expect(redisState[ACTIVE_KEY]).toBe("1");
      // Removed from queue after acquiring
      expect(redisList[QUEUE_KEY] ?? []).toHaveLength(0);
    });

    it("acquires immediately when active count is below limit", async () => {
      redisState[ACTIVE_KEY] = "1";

      const acquired = await enqueueAndTryAcquire("deploy-2");
      expect(acquired).toBe(true);
      expect(redisState[ACTIVE_KEY]).toBe("2");
    });

    it("does not acquire when at concurrency limit", async () => {
      redisState[ACTIVE_KEY] = "2";

      const acquired = await enqueueAndTryAcquire("deploy-3");
      expect(acquired).toBe(false);
      expect(redisList[QUEUE_KEY]).toContain("deploy-3");
    });

    it("does not acquire when another deploy is queued ahead", async () => {
      redisList[QUEUE_KEY] = ["deploy-1"];
      redisState[ACTIVE_KEY] = "2";

      const acquired = await enqueueAndTryAcquire("deploy-2");
      expect(acquired).toBe(false);
      expect(redisList[QUEUE_KEY]).toEqual(["deploy-1", "deploy-2"]);
    });

    it("respects VARDO_MAX_DEPLOY_CONCURRENCY env var", async () => {
      process.env.VARDO_MAX_DEPLOY_CONCURRENCY = "1";
      redisState[ACTIVE_KEY] = "1";

      const acquired = await enqueueAndTryAcquire("deploy-x");
      expect(acquired).toBe(false);
    });

    it("returns true (fail-safe) when Redis throws", async () => {
      redisMock.rpush.mockRejectedValueOnce(new Error("Redis down"));

      const acquired = await enqueueAndTryAcquire("deploy-fail");
      expect(acquired).toBe(true);
    });
  });

  describe("releaseConcurrencySlot", () => {
    it("decrements the active counter", async () => {
      redisState[ACTIVE_KEY] = "2";
      await releaseConcurrencySlot();
      expect(redisState[ACTIVE_KEY]).toBe("1");
    });

    it("does not go below zero", async () => {
      redisState[ACTIVE_KEY] = "0";
      await releaseConcurrencySlot();
      expect(redisState[ACTIVE_KEY]).toBe("0");
    });

    it("handles missing active key gracefully", async () => {
      await expect(releaseConcurrencySlot()).resolves.not.toThrow();
    });
  });

  describe("removeFromQueue", () => {
    it("removes a specific deployment from the queue", async () => {
      redisList[QUEUE_KEY] = ["deploy-1", "deploy-2", "deploy-3"];
      await removeFromQueue("deploy-2");
      expect(redisList[QUEUE_KEY]).toEqual(["deploy-1", "deploy-3"]);
    });

    it("is a no-op if the deployment is not in the queue", async () => {
      redisList[QUEUE_KEY] = ["deploy-1"];
      await removeFromQueue("deploy-99");
      expect(redisList[QUEUE_KEY]).toEqual(["deploy-1"]);
    });
  });

  describe("waitForConcurrencySlot", () => {
    it("resolves on first poll when at head and slot is available", async () => {
      redisList[QUEUE_KEY] = ["deploy-1"];
      redisState[ACTIVE_KEY] = "1"; // One slot in use, limit is 2

      await expect(waitForConcurrencySlot("deploy-1")).resolves.not.toThrow();
      expect(redisState[ACTIVE_KEY]).toBe("2");
      expect(redisList[QUEUE_KEY] ?? []).toHaveLength(0);
    });

    it("throws and cleans up when AbortSignal fires", async () => {
      // deploy-1 is behind deploy-0 and slots are full — will never advance
      redisList[QUEUE_KEY] = ["deploy-0", "deploy-1"];
      redisState[ACTIVE_KEY] = "2";

      const controller = new AbortController();
      const waitPromise = waitForConcurrencySlot("deploy-1", controller.signal);

      controller.abort();

      await expect(waitPromise).rejects.toThrow("cancelled while waiting");
      expect((redisList[QUEUE_KEY] ?? []).includes("deploy-1")).toBe(false);
    });

    it("throws and cleans up when the 9-min deadline expires", async () => {
      // deploy-timeout is behind another deploy and slots are full — will never advance
      redisList[QUEUE_KEY] = ["deploy-ahead", "deploy-timeout"];
      redisState[ACTIVE_KEY] = "2";

      // First Date.now() sets the deadline; all subsequent calls return past it
      const frozenNow = Date.now();
      let calls = 0;
      const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return calls++ === 0 ? frozenNow : frozenNow + 10 * 60 * 1000;
      });

      try {
        await expect(waitForConcurrencySlot("deploy-timeout")).rejects.toThrow(
          "waited too long for a concurrency slot",
        );
        expect((redisList[QUEUE_KEY] ?? []).includes("deploy-timeout")).toBe(false);
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("proceeds without enforcement on Redis error during poll", async () => {
      // Slot is not available, but eval throws on first attempt
      redisList[QUEUE_KEY] = ["deploy-redis-err"];
      redisState[ACTIVE_KEY] = "2";

      redisMock.eval.mockRejectedValueOnce(new Error("Redis connection failed"));

      await expect(waitForConcurrencySlot("deploy-redis-err")).resolves.not.toThrow();
    });
  });

  describe("getConcurrencyState", () => {
    it("returns current state", async () => {
      redisState[ACTIVE_KEY] = "1";
      redisList[QUEUE_KEY] = ["deploy-a", "deploy-b"];

      const state = await getConcurrencyState();
      expect(state.active).toBe(1);
      expect(state.queued).toBe(2);
      expect(state.queuedIds).toEqual(["deploy-a", "deploy-b"]);
      expect(state.limit).toBe(2);
    });

    it("returns zeros when nothing is running or queued", async () => {
      const state = await getConcurrencyState();
      expect(state.active).toBe(0);
      expect(state.queued).toBe(0);
    });
  });

  describe("getConcurrencyLimit", () => {
    it("returns the default limit when env var is not set", () => {
      expect(getConcurrencyLimit()).toBe(2);
    });

    it("returns the default limit when env var is not a valid integer", () => {
      process.env.VARDO_MAX_DEPLOY_CONCURRENCY = "banana";
      expect(getConcurrencyLimit()).toBe(2);
    });

    it("clamps to a minimum of 1", () => {
      process.env.VARDO_MAX_DEPLOY_CONCURRENCY = "0";
      expect(getConcurrencyLimit()).toBe(1);
    });
  });

  describe("reconcileQueue", () => {
    it("removes orphaned IDs not present in activeIds", async () => {
      redisList[QUEUE_KEY] = ["deploy-legit", "deploy-orphan"];
      await reconcileQueue(new Set(["deploy-legit"]));
      expect(redisList[QUEUE_KEY]).toEqual(["deploy-legit"]);
    });

    it("preserves all IDs when they are all legitimate", async () => {
      redisList[QUEUE_KEY] = ["deploy-1", "deploy-2"];
      await reconcileQueue(new Set(["deploy-1", "deploy-2"]));
      expect(redisList[QUEUE_KEY]).toEqual(["deploy-1", "deploy-2"]);
    });

    it("is a no-op when the queue is empty", async () => {
      await expect(reconcileQueue(new Set(["deploy-1"]))).resolves.not.toThrow();
      expect(redisList[QUEUE_KEY] ?? []).toHaveLength(0);
    });

    it("handles Redis errors gracefully without throwing", async () => {
      redisMock.lrange.mockRejectedValueOnce(new Error("Redis connection lost"));
      await expect(reconcileQueue(new Set())).resolves.not.toThrow();
    });
  });

  describe("reconcileActiveCounter", () => {
    it("corrects an over-counted active counter", async () => {
      redisState[ACTIVE_KEY] = "3";
      await reconcileActiveCounter(1);
      expect(redisState[ACTIVE_KEY]).toBe("1");
    });

    it("deletes the key when no deploys are running", async () => {
      redisState[ACTIVE_KEY] = "2";
      await reconcileActiveCounter(0);
      expect(redisState[ACTIVE_KEY]).toBeUndefined();
    });

    it("does nothing when the counter is already correct", async () => {
      redisState[ACTIVE_KEY] = "2";
      const prevSetCalls = redisMock.set.mock.calls.length;
      await reconcileActiveCounter(2);
      // set should not have been called
      expect(redisMock.set.mock.calls.length).toBe(prevSetCalls);
    });

    it("caps expected count at concurrency limit", async () => {
      process.env.VARDO_MAX_DEPLOY_CONCURRENCY = "2";
      redisState[ACTIVE_KEY] = "5";
      await reconcileActiveCounter(4); // 4 running but limit is 2
      expect(redisState[ACTIVE_KEY]).toBe("2");
    });
  });
});
