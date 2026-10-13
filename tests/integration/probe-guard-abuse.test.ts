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

  it("reads a range for all apps or one, with ended bans and their status", async () => {
    const { guardHistory } = await import("@/lib/probe-guard/history");
    await sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('p1', 'org1', 'proj', 'Proj')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name) values ('a1', 'org1', 'p1', 'one', 'One'), ('a2', 'org1', 'p1', 'two', 'Two')`;
    const now = new Date();
    const at = (h: number) => new Date(now.getTime() - h * HOUR);
    for (const [ip, path, app, h] of [
      ["198.51.100.1", "/.env", "a1", 2],
      ["198.51.100.1", "/.env", "a1", 2],
      ["198.51.100.1", "/_ignition/execute-solution", "a1", 3],
      ["198.51.100.2", "/.ssh/id_rsa", "a2", 4],
      ["198.51.100.3", "/.env", "a2", 24 * 20],
    ] as const) {
      await sql`insert into probe_event (id, kind, ip, path, app_id, created_at) values (${`${ip}-${path}-${h}-${Math.random()}`}, 'probe', ${ip}, ${path}, ${app}, ${at(h)})`;
    }
    await sql`insert into probe_ban (id, ip, reason, app_id, created_at, expires_at) values ('h1', '198.51.100.1', 'threshold', 'a1', ${at(2)}, ${at(1)})`;
    await sql`insert into probe_ban (id, ip, reason, app_id, created_at, expires_at, lifted_at) values ('h2', '198.51.100.2', 'trap', 'a2', ${at(4)}, ${new Date(now.getTime() + HOUR)}, ${at(3)})`;

    const week = await guardHistory({ range: "7d", now });
    expect(week.categories).toEqual([
      { label: "env files", count: 2 },
      { label: "Laravel Ignition exploit (RCE)", count: 1 },
      { label: "SSH keys", count: 1 },
    ]);
    expect(week.byApp.map((a) => a.appId)).toEqual(["a1", "a2"]);
    expect(week.sources[0]).toEqual({ ip: "198.51.100.1", count: 3, banned: false });
    const statuses = Object.fromEntries(week.bans.filter((b) => b.id.startsWith("h")).map((b) => [b.id, b.status.kind]));
    expect(statuses).toEqual({ h1: "expired", h2: "lifted" });

    const one = await guardHistory({ range: "7d", appId: "a2", now });
    expect(one.categories).toEqual([{ label: "SSH keys", count: 1 }]);
    expect(one.bans.map((b) => b.id)).toEqual(["h2"]);
    expect(one.byApp).toEqual([]);

    const month = await guardHistory({ range: "30d", appId: "a2", now });
    expect(month.categories.find((c) => c.label === "env files")?.count).toBe(1);
  });

  it("refuses bans shared by a linked instance for allowlisted addresses", async () => {
    const outcome = await bans.createBan({
      ip: "203.0.113.3",
      reason: "threshold",
      origin: { peerId: "peer", name: "Linked", expiresAt: new Date(Date.now() + HOUR) },
    });
    expect(outcome).toEqual({ status: "refused", reason: "on the allowlist" });
  });

  it("doubles a repeat offender's ban, counting only local bans from the last 30 days", async () => {
    const ip = "203.0.113.60";
    const now = new Date();
    await insert("old", ip, "threshold", new Date(now.getTime() - 31 * 24 * HOUR), new Date(now.getTime() - 31 * 24 * HOUR + HOUR));
    await insert("list", ip, "blocklist", new Date(now.getTime() - 2 * HOUR), new Date(now.getTime() - HOUR));

    const lengths: number[] = [];
    let at = now;
    for (const reason of ["threshold", "trap", "threshold", "threshold", "threshold", "threshold"] as const) {
      const outcome = await bans.createBan({ ip, reason, hits: 5 }, at);
      if (outcome.status !== "banned") throw new Error(`not banned: ${JSON.stringify(outcome)}`);
      lengths.push((outcome.ban.expiresAt.getTime() - at.getTime()) / HOUR);
      at = new Date(outcome.ban.expiresAt.getTime() + 60_000);
    }
    expect(lengths).toEqual([1, 2, 4, 8, 16, 24]);
  });
});