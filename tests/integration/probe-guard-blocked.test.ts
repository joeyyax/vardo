// Per-ban block counts against a scratch Postgres.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/redis", () => ({ redis: {} }));

const conn = await connectScratchServer();
const HOUR = 3_600_000;

describe.skipIf(!conn)("ban block counts on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("probe_blocked");
  let sql: ReturnType<typeof postgres>;
  let bans: typeof import("@/lib/probe-guard/bans");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    bans = await import("@/lib/probe-guard/bans");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  it("adds counts, keeps the latest time and skips missing bans", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + HOUR);
    await sql`insert into probe_ban (id, ip, reason, created_at, expires_at) values ('b1', '203.0.113.1', 'trap', ${now}, ${later})`;
    await bans.addBanBlocks([{ id: "b1", count: 3, lastAt: later }, { id: "gone", count: 9, lastAt: now }]);
    await bans.addBanBlocks([{ id: "b1", count: 2, lastAt: now }]);
    const [view] = await bans.listActiveBans({}, now);
    expect(view.blockedCount).toBe(5);
    expect(view.lastBlockedAt?.toISOString()).toBe(later.toISOString());
  });

  it("indexes active bans by address, a local ban over a blocklist one", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + HOUR);
    await sql`insert into probe_ban (id, ip, reason, hits, created_at, expires_at) values ('a1', '198.51.100.9', 'blocklist', 100, ${now}, ${later})`;
    const refs = await bans.activeBanRefs(now);
    expect(refs.get("198.51.100.9")).toEqual({ id: "a1", blocklist: true, expiresAt: later });
    expect(refs.get("203.0.113.1")).toMatchObject({ id: "b1", blocklist: false });
  });
});
