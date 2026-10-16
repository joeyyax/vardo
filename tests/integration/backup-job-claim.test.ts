// A job's claim outlives a Redis outage longer than its TTL: renewal takes it back, or warns when another run has it.
// Skips without a Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

async function connectRedis(): Promise<Redis | null> {
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:7200", { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
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

const client = await connectRedis();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BEAT = 20;

describe.skipIf(!client)("job claim renewal on Redis", () => {
  let claims: typeof import("@/lib/backups/job-claim");
  let shared: typeof import("@/lib/redis").redis;
  let warn: ReturnType<typeof vi.fn>;
  let jobId: string;
  let key: string;
  let n = 0;

  beforeEach(async () => {
    claims = await import("@/lib/backups/job-claim");
    shared = (await import("@/lib/redis")).redis;
    warn = (await import("@/lib/logger")).logger.warn as ReturnType<typeof vi.fn>;
    warn.mockClear();
    // Unique per test and process: the Redis is shared.
    jobId = `claim-${process.pid}-${Date.now()}-${n++}`;
    key = claims.jobClaimKey(jobId);
  });

  afterAll(async () => {
    client!.disconnect();
    (await import("@/lib/redis")).redis.disconnect();
  });

  it("takes the claim back when Redis returns after it lapsed", async () => {
    const release = await claims.claimJob(jobId, "scheduled", new Date(), BEAT);
    const value = await client!.get(key);

    shared.disconnect();
    await client!.pexpire(key, 1);
    await sleep(BEAT * 5);
    expect(await client!.exists(key)).toBe(0);
    await shared.connect();

    await vi.waitFor(async () => expect(await client!.get(key)).toBe(value));
    expect(await client!.pttl(key)).toBeGreaterThan(20_000);
    expect(warn).not.toHaveBeenCalled();
    await release!();
    expect(await client!.exists(key)).toBe(0);
  });

  it("warns once, naming both runs, when another run took the claim, and leaves it with that run", async () => {
    const release = await claims.claimJob(jobId, "scheduled", new Date("2026-10-15T02:00:00Z"), BEAT);
    const other = JSON.stringify({ by: "manual", startedAt: "2026-10-15T02:01:00.000Z", token: "other" });
    await client!.set(key, other, "PX", 30_000);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(jobId);
    expect(message).toContain("a manual run from 2026-10-15T02:01:00.000Z");
    expect(message).toContain("a scheduled run from 2026-10-15T02:00:00.000Z");
    await sleep(BEAT * 5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await client!.get(key)).toBe(other);

    await release!();
    expect(await client!.get(key)).toBe(other);
    await client!.del(key);
  });
});
