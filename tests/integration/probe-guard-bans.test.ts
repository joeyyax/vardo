// Permanent probe bans against a scratch Postgres: storage, guard file order and pruning.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import type * as InstanceModule from "@/lib/probe-guard/instance";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/redis", () => ({ redis: {} }));

// Sharing itself is covered in the unit tests; here only whether bans.ts decides to share.
const share = vi.hoisted(() => ({
  on: false,
  shareBan: vi.fn(async () => ({ sent: 0, failed: 0 })),
  shareLift: vi.fn(async () => ({ sent: 0, failed: 0 })),
}));
vi.mock("@/lib/probe-guard/mesh-share", () => ({ shareBan: share.shareBan, shareLift: share.shareLift }));
vi.mock("@/lib/probe-guard/instance", async (original) => ({
  ...(await original<typeof InstanceModule>()),
  getProbeGuardSettings: async () => ({ ...DEFAULT_INSTANCE_PROBE_GUARD, shareBans: share.on }),
}));

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

  describe("lifts shared between linked instances", () => {
    const row = (id: string, ip: string, reason: string, expiresAt: Date) =>
      sql`insert into probe_ban (id, ip, reason, created_at, expires_at) values (${id}, ${ip}, ${reason}, now() - interval '5 minutes', ${expiresAt})`;
    const lifted = async (id: string) => (await sql`select lifted_at, lifted_by from probe_ban where id = ${id}`)[0];
    const future = () => new Date(Date.now() + HOUR);

    it("ends another instance's temporary bans on the address and leaves everything else", async () => {
      const ip = "198.51.100.10";
      await row("lp-threshold", ip, "threshold", future());
      await row("lp-mesh", ip, "mesh", future());
      await row("lp-trap", ip, "trap", future());
      await row("lp-blocklist", ip, "blocklist", future());
      await row("lp-permanent", ip, "threshold", permanent.PERMANENT_UNTIL);
      await row("lp-expired", ip, "threshold", new Date(Date.now() - HOUR));
      await row("lp-other-ip", "198.51.100.11", "threshold", future());

      expect(await bans.liftBansForPeer(ip, { id: "peer-east" })).toBe(3);

      for (const id of ["lp-threshold", "lp-mesh", "lp-trap"]) {
        const r = await lifted(id);
        expect(r.lifted_at, id).not.toBeNull();
        expect(r.lifted_by, id).toBe("mesh:peer-east");
      }
      for (const id of ["lp-blocklist", "lp-permanent", "lp-expired", "lp-other-ip"]) expect((await lifted(id)).lifted_at, id).toBeNull();
      const stillActive = await sql`select id from probe_ban where ip = ${ip} and lifted_at is null and expires_at > now() order by id`;
      expect(stillActive.map((r) => r.id)).toEqual(["lp-blocklist", "lp-permanent"]);
      expect(share.shareLift).not.toHaveBeenCalled();
    });

    it("does nothing for an address with no active ban, and doesn't redo a lifted one", async () => {
      expect(await bans.liftBansForPeer("198.51.100.99", { id: "peer-east" })).toBe(0);
      expect(await bans.liftBansForPeer("198.51.100.10", { id: "peer-east" })).toBe(0);
    });

    it("tells linked instances about an admin's lift only when sharing is on", async () => {
      share.shareLift.mockClear();
      await row("ls-off", "198.51.100.20", "threshold", future());
      share.on = false;
      expect(await bans.liftBan("ls-off", "user-1")).toBe(true);
      expect(share.shareLift).not.toHaveBeenCalled();

      await row("ls-on", "198.51.100.21", "threshold", future());
      share.on = true;
      expect(await bans.liftBan("ls-on", "user-1")).toBe(true);
      expect(share.shareLift).toHaveBeenCalledExactlyOnceWith("198.51.100.21");
      expect((await lifted("ls-on")).lifted_by).toBe("user-1");
    });

    it("shares the lift of a ban that came from a linked instance, so it spreads both ways", async () => {
      share.shareLift.mockClear();
      share.on = true;
      await row("ls-mesh", "198.51.100.22", "mesh", future());
      expect(await bans.liftBan("ls-mesh", "user-1")).toBe(true);
      expect(share.shareLift).toHaveBeenCalledExactlyOnceWith("198.51.100.22");
    });

    it("shares nothing for a blocklist ban, an already-ended ban or a ban that isn't there", async () => {
      share.shareLift.mockClear();
      share.on = true;
      await row("ls-blocklist", "198.51.100.23", "blocklist", future());
      await row("ls-ended", "198.51.100.24", "threshold", new Date(Date.now() - HOUR));
      expect(await bans.liftBan("ls-blocklist", "user-1")).toBe(true);
      expect(await bans.liftBan("ls-ended", "user-1")).toBe(true);
      expect(await bans.liftBan("ls-missing", "user-1")).toBe(false);
      expect(await bans.liftBan("ls-on", "user-1")).toBe(false);
      expect(share.shareLift).not.toHaveBeenCalled();
    });
  });
});
