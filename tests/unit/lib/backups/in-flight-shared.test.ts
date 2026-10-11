// A self-deploy's drain waits for and pauses backup work in the old slot's other processes, through Redis.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeRedis } from "../../helpers/fake-redis";

const fake = vi.hoisted(() => ({ redis: null as unknown as ReturnType<typeof createFakeRedis> }));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/redis", () => ({
  get redis() {
    return fake.redis;
  },
}));

const {
  DRAIN_FLAG_FRESH_MS,
  backupBusyKey,
  backupDrainKey,
  backupsDraining,
  beatBackupWork,
  drainBackupsForStop,
  endBackupDrain,
  otherBackupWork,
  parseBusyValue,
  resetBackupWorkForTests,
  trackBackupWork,
} = await import("@/lib/backups/in-flight");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const worker = (slot: string | null, work = "backup job job-9") =>
  fake.redis.set("backup:busy:worker-host:7", JSON.stringify({ slot, work }), "PX", 30_000);

beforeEach(() => {
  fake.redis = createFakeRedis();
  resetBackupWorkForTests();
});

describe("the beacon", () => {
  it("writes this process's work under backup:busy:*, which the watchdog and install.sh count", async () => {
    let release!: () => void;
    const run = trackBackupWork("backup", "job job-1", () => new Promise<void>((r) => (release = r)));
    await beatBackupWork("blue");
    const value = await fake.redis.get(backupBusyKey());
    expect(backupBusyKey().startsWith("backup:busy:")).toBe(true);
    expect(parseBusyValue(value!)).toEqual({ slot: "blue", work: "backup job job-1" });

    release();
    await run;
    await beatBackupWork("blue");
    expect(await fake.redis.get(backupBusyKey())).toBeNull();
  });

  it("follows a drain flag for its own slot or for every slot", async () => {
    await fake.redis.set(backupDrainKey("blue"), "1", "PX", 30_000);
    await beatBackupWork("green");
    expect(backupsDraining()).toBe(false);
    await beatBackupWork("blue");
    expect(backupsDraining()).toBe(true);

    await fake.redis.del(backupDrainKey("blue"));
    await fake.redis.set(backupDrainKey(null), "1", "PX", 30_000);
    await beatBackupWork(null);
    expect(backupsDraining()).toBe(true);
  });

  it("stops pausing once the flag can't be read for a while", async () => {
    const now = Date.now();
    await fake.redis.set(backupDrainKey("blue"), "1", "PX", 30_000);
    await beatBackupWork("blue", now);
    fake.redis.ctl.down = true;
    await expect(beatBackupWork("blue", now + 1000)).rejects.toThrow();
    expect(backupsDraining(now + 1000)).toBe(true);
    expect(backupsDraining(now + DRAIN_FLAG_FRESH_MS)).toBe(false);
  });
});

describe("otherBackupWork", () => {
  it("lists other processes in the slot, skipping this one and other slots", async () => {
    await fake.redis.set(backupBusyKey(), JSON.stringify({ slot: "blue", work: "mine" }));
    await worker("blue");
    await fake.redis.set("backup:busy:new-web:3", JSON.stringify({ slot: "green", work: "restore of backup b-1" }));
    await fake.redis.set("backup:busy:old:4", "drill of backup b-2");
    const found = await otherBackupWork("blue");
    expect(found.map((w) => w.work).sort()).toEqual(["backup job job-9", "drill of backup b-2"]);
    expect((await otherBackupWork(null)).length).toBe(3);
  });

  it("parses plain-text values from older releases", () => {
    expect(parseBusyValue("backup job a")).toEqual({ slot: null, work: "backup job a" });
  });
});

describe("drainBackupsForStop across processes", () => {
  it("waits for the old slot's worker, sets the slot's drain flag and clears it after", async () => {
    await worker("blue");
    const lines: string[] = [];
    let done = false;
    const drain = drainBackupsForStop((l) => lines.push(l), 5_000, 5, { slot: "blue" }).then((left) => {
      done = true;
      return left;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(lines[0]).toContain("in other processes: backup job job-9 (worker-host:7)");
    expect(await fake.redis.get(backupDrainKey("blue"))).not.toBeNull();
    expect(backupsDraining()).toBe(true);

    await fake.redis.del("backup:busy:worker-host:7");
    expect(await drain).toEqual([]);
    expect(lines.at(-1)).toContain("finished");

    endBackupDrain();
    await settle();
    expect(await fake.redis.get(backupDrainKey("blue"))).toBeNull();
    expect(backupsDraining()).toBe(false);
  });

  it("doesn't wait on the new slot's work", async () => {
    await worker("green");
    expect(await drainBackupsForStop(() => {}, 5_000, 5, { slot: "blue" })).toEqual([]);
  });

  it("stops waiting on a dead process once its key's TTL runs out", async () => {
    await fake.redis.set("backup:busy:dead:1", JSON.stringify({ slot: "blue", work: "backup job gone" }), "PX", 40);
    const started = Date.now();
    expect(await drainBackupsForStop(() => {}, 5_000, 5, { slot: "blue" })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("names the other process's work it cut off at the deadline", async () => {
    await worker("blue");
    expect(await drainBackupsForStop(() => {}, 30, 5, { slot: "blue" })).toEqual(["backup job job-9 (worker-host:7)"]);
  });

  it("falls back to this process's work when Redis is down", async () => {
    fake.redis.ctl.down = true;
    let release!: () => void;
    const run = trackBackupWork("backup", "job job-1", () => new Promise<void>((r) => (release = r)));
    const drain = drainBackupsForStop(() => {}, 5_000, 5, { slot: "blue" });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await run;
    expect(await drain).toEqual([]);
  });

  it("without a scope leaves other processes alone", async () => {
    await worker("blue");
    expect(await drainBackupsForStop(() => {}, 5_000, 5)).toEqual([]);
    expect(await fake.redis.get(backupDrainKey("blue"))).toBeNull();
  });
});
