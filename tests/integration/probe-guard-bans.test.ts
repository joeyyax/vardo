// Permanent probe bans against a scratch Postgres: storage, guard file order and pruning.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/redis", () => ({ redis: {} }));

const conn = await connectScratchServer();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!conn)("permanent probe bans on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("probe_bans");
  let sql: ReturnType<typeof postgres>;
  let bans: typeof import("@/lib/probe-guard/bans");
  let sync: typeof import("@/lib/probe-guard/sync");
  let permanent: typeof import("@/lib/probe-guard/permanent");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    bans = await import("@/lib/probe-guard/bans");
    sync = await import("@/lib/probe-guard/sync");
    permanent = await import("@/lib/probe-guard/permanent");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  async function insert(id: string, ip: string, createdAt: Date, expiresAt: Date) {
    await sql`insert into probe_ban (id, ip, reason, created_at, expires_at) values (${id}, ${ip}, 'threshold', ${createdAt}, ${expiresAt})`;
  }

  it("stores and reads back the sentinel", async () => {
    const now = new Date();
    await insert("p1", "203.0.113.1", new Date(now.getTime() - 400 * DAY), permanent.PERMANENT_UNTIL);
    const [view] = await bans.listActiveBans({}, now);
    expect(view.expiresAt.toISOString()).toBe(permanent.PERMANENT_UNTIL.toISOString());
    expect(permanent.isPermanent(view.expiresAt)).toBe(true);
    expect(await bans.permanentBanCount()).toBe(1);
  });

  it("renders permanent bans first, then the newest temporary ones", async () => {
    const now = new Date();
    await insert("t1", "203.0.113.2", new Date(now.getTime() - 2 * HOUR), new Date(now.getTime() + HOUR));
    await insert("t2", "203.0.113.3", new Date(now.getTime() - HOUR), new Date(now.getTime() + 5 * HOUR));
    await insert("p2", "203.0.113.4", new Date(now.getTime() - 10 * DAY), permanent.PERMANENT_UNTIL);
    const ips = await sync.activeBannedIps(now);
    expect(ips.slice(0, 2).sort()).toEqual(["203.0.113.1", "203.0.113.4"]);
    expect(ips.slice(2)).toEqual(["203.0.113.3", "203.0.113.2"]);
  });

  it("prunes bans past the 90-day retention, keeping active permanent bans", async () => {
    const now = new Date();
    await insert("old", "203.0.113.5", new Date(now.getTime() - 150 * DAY), new Date(now.getTime() - 120 * DAY));
    await insert("kept", "203.0.113.7", new Date(now.getTime() - 70 * DAY), new Date(now.getTime() - 60 * DAY));
    await insert("p3", "203.0.113.6", new Date(now.getTime() - 150 * DAY), permanent.PERMANENT_UNTIL);
    await sql`update probe_ban set lifted_at = ${new Date(now.getTime() - 120 * DAY)} where id = 'p3'`;
    await bans.pruneBans(now);
    const ids = (await sql`select id from probe_ban order by id`).map((r) => r.id);
    expect(ids).toEqual(["kept", "p1", "p2", "t1", "t2"]);
  });
});
