// Blocklist bans and the allowlist against a scratch Postgres.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/redis", () => ({ redis: { del: async () => 0 } }));
vi.mock("@/lib/server-ip", () => ({ getServerIP: async () => "198.51.100.250" }));
vi.mock("@/lib/config/sync", () => ({ publishConfigChange: async () => {} }));

const conn = await connectScratchServer();
const HOUR = 3_600_000;

describe.skipIf(!conn)("blocklist and allowlist on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("probe_abuse");
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  let sql: ReturnType<typeof postgres>;
  let bans: typeof import("@/lib/probe-guard/bans");
  let sync: typeof import("@/lib/probe-guard/sync");
  let actions: typeof import("@/lib/probe-guard/allowlist-actions");
  let permanent: typeof import("@/lib/probe-guard/permanent");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    process.env.TRAEFIK_DYNAMIC_DIR = dir;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    bans = await import("@/lib/probe-guard/bans");
    sync = await import("@/lib/probe-guard/sync");
    actions = await import("@/lib/probe-guard/allowlist-actions");
    permanent = await import("@/lib/probe-guard/permanent");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
    rmSync(dir, { recursive: true, force: true });
  }, MIGRATE_TIMEOUT);

  async function insert(id: string, ip: string, reason: string, createdAt: Date, expiresAt: Date) {
    await sql`insert into probe_ban (id, ip, reason, created_at, expires_at) values (${id}, ${ip}, ${reason}, ${createdAt}, ${expiresAt})`;
  }

  it("imports blocklist bans, skipping never-ban, locally banned and unbanned addresses", async () => {
    const now = new Date();
    await insert("local", "203.0.113.1", "threshold", new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
    await insert("lifted", "203.0.113.2", "blocklist", new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR));
    await sql`update probe_ban set lifted_at = now() where id = 'lifted'`;
    const added = await bans.applyBlocklistBans([
      { ip: "203.0.113.1", score: 100 },
      { ip: "203.0.113.2", score: 100 },
      { ip: "10.0.0.9", score: 100 },
      { ip: "198.51.100.250", score: 100 },
      { ip: "203.0.113.3", score: 95 },
      { ip: "203.0.113.4", score: 100 },
    ], now);
    expect(added).toBe(2);
    const rows = await sql`select ip, hits, expires_at from probe_ban where reason = 'blocklist' and lifted_at is null order by ip`;
    expect(rows.map((r) => r.ip)).toEqual(["203.0.113.3", "203.0.113.4"]);
    expect(new Date(rows[0].expires_at).getTime() - now.getTime()).toBe(24 * HOUR);
    expect(await bans.blocklistBanCount(now)).toBe(2);
  });

  it("refreshes rather than piles up, and keeps blocklist bans out of the ban list", async () => {
    const now = new Date();
    await bans.applyBlocklistBans([{ ip: "203.0.113.4", score: 100 }], now);
    expect(await bans.blocklistBanCount(now)).toBe(1);
    const listed = await bans.listActiveBans({}, now);
    expect(listed.map((b) => b.reason)).not.toContain("blocklist");
  });

  it("renders permanent, then local, then blocklist bans", async () => {
    const now = new Date();
    await insert("perm", "203.0.113.9", "trap", new Date(now.getTime() - 100 * 24 * HOUR), permanent.PERMANENT_UNTIL);
    expect(await sync.activeBannedIps(now)).toEqual(["203.0.113.9", "203.0.113.1", "203.0.113.4"]);
  });

  it("never makes a blocklist ban permanent", async () => {
    const [row] = await sql`select id from probe_ban where reason = 'blocklist' and lifted_at is null limit 1`;
    expect(await bans.makeBanPermanent(row.id, null)).toBeNull();
  });

  it("lifts covered bans when an entry is added, and refuses new ones", async () => {
    const result = await actions.addAllowEntry({ value: "203.0.113.0/30", note: "Scanner" }, null);
    expect(result.lifted).toBe(1);
    const active = (await sql`select ip from probe_ban where lifted_at is null and expires_at > now() order by ip`).map((r) => r.ip);
    expect(active).toEqual(["203.0.113.4", "203.0.113.9"]);
    expect(await bans.createBan({ ip: "203.0.113.2", reason: "trap" })).toEqual({ status: "refused", reason: "on the allowlist" });
    await expect(actions.addAllowEntry({ value: "203.0.113.0/30" }, null)).rejects.toThrow(/already/);
  });

  it("refuses bans shared by a linked instance for allowlisted addresses", async () => {
    const outcome = await bans.createBan({
      ip: "203.0.113.3",
      reason: "threshold",
      origin: { peerId: "peer", name: "Linked", expiresAt: new Date(Date.now() + HOUR) },
    });
    expect(outcome).toEqual({ status: "refused", reason: "on the allowlist" });
  });
});
