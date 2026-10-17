// The uptime engine against a scratch Postgres: auto monitors, checks, rollups and incidents.
// Skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

type Emitted = { orgId: string; type: string; title?: string; message?: string; subject?: string; alerts?: unknown[]; incident?: { state: string } };
const h = vi.hoisted(() => ({ emitted: [] as Emitted[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: Emitted) =>
    void h.emitted.push({ orgId, type: event.type, title: event.title, message: event.message, subject: event.subject, alerts: event.alerts, incident: event.incident }),
}));
vi.mock("@/lib/uptime/outbound", async (orig) => ({
  ...(await orig<typeof import("@/lib/uptime/outbound")>()),
  checkDeps: async () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), guard: async () => null }),
}));
vi.mock("@/lib/activity/record", () => ({ recordActivity: async () => {} }));

const conn = await connectScratchServer();

describe.skipIf(!conn)("uptime engine on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("uptime_engine");
  let sql: ReturnType<typeof postgres>;
  let engine: typeof import("@/lib/uptime/engine");
  let client: typeof import("@/lib/uptime/client");
  let status = 200;
  const org = { kind: "org", orgId: "org1" } as const;
  let t = Date.UTC(2026, 0, 10, 12, 0, 0);
  const at = () => t;
  const emitted = () => h.emitted;
  const flush = async () => (await import("@/lib/uptime/notices")).flushNotices(t);

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('proj1', 'org1', 'shop', 'Shop')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status) values ('app1', 'org1', 'proj1', 'shop', 'Shop', 'active')`;
    await sql`insert into domain (id, app_id, domain, is_primary) values ('dom1', 'app1', 'shop.example.com', true)`;
    await sql`insert into environment (id, app_id, name, type, domain) values ('env1', 'app1', 'pr-7', 'preview', 'shop-pr-7.example.com')`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    vi.stubGlobal("fetch", async () => new Response("ok", { status }));
    engine = await import("@/lib/uptime/engine");
    client = await import("@/lib/uptime/client");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  async function pass(minutes = 1) {
    for (let i = 0; i < minutes; i++) {
      t += 60_000;
      vi.setSystemTime(t);
      await engine.runDueChecks(t, at);
    }
  }

  it("creates auto monitors for domains, previews and the console", async () => {
    expect(await engine.syncAutoMonitors()).toEqual({ added: 3, removed: 0 });
    const monitors = await client.uptimeClient.listMonitors(org);
    expect(monitors.map((m) => [m.name, m.target, m.preview, m.source]).sort()).toEqual([
      ["shop-pr-7.example.com", "https://shop-pr-7.example.com", true, "auto"],
      ["shop.example.com", "https://shop.example.com", false, "auto"],
    ]);
    const instance = await client.uptimeClient.listMonitors({ kind: "instance" });
    expect(instance.map((m) => m.name)).toEqual(["Vardo console"]);
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
  });

  it("counts any response below 500 as up for automatic monitors, and fixes the ones stored with the old range", async () => {
    await sql`update uptime_monitor set "check" = jsonb_set("check", '{expectedStatus}', '{"min":200,"max":399}') where source = 'auto'`;
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
    const stored = await sql`select "check"->'expectedStatus' as s from uptime_monitor where source = 'auto'`;
    expect(stored.map((r) => r.s)).toEqual([{ min: 100, max: 499 }, { min: 100, max: 499 }, { min: 100, max: 499 }]);

    status = 404;
    await pass(2);
    const states = await client.uptimeClient.listMonitors(org);
    expect(states.every((m) => m.state === "up")).toBe(true);
    status = 200;
    await pass(1);

    // A manual monitor keeps the range it was given.
    const manual = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://api.example.com/" });
    expect(manual.check).toMatchObject({ expectedStatus: { min: 200, max: 399 } });
    await sql`delete from uptime_monitor where id = ${manual.id}`;
  });

  it("makes no monitor for a domain that can't be public, and drops the one it had", async () => {
    await sql`insert into domain (id, app_id, domain, is_primary) values ('d-local', 'app1', 'plextraktsync.localhost', false), ('d-bare', 'app1', 'nas', false), ('d-lan', 'app1', 'files.lan', false), ('d-test', 'app1', 'app.test', false)`;
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
    const names = (await client.uptimeClient.listMonitors(org)).map((m) => m.name).sort();
    expect(names).toEqual(["shop-pr-7.example.com", "shop.example.com"]);

    // One that already exists goes in the same sync.
    await sql`insert into uptime_monitor (id, organization_id, name, "check", source, app_id, domain_id) values ('mon_old', 'org1', 'plextraktsync.localhost', '{"type":"http","url":"https://plextraktsync.localhost","expectedStatus":{"min":200,"max":399},"timeoutMs":10000}', 'auto', 'app1', 'd-local')`;
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 1 });
    await sql`delete from domain where id in ('d-local', 'd-bare', 'd-lan', 'd-test')`;
  });

  it("tells you about an outage once it has held, in one notice, with names", async () => {
    await pass(2);
    const up = await client.uptimeClient.listMonitors(org);
    expect(up.every((m) => m.state === "up" && m.localOnly)).toBe(true);
    expect(emitted()).toEqual([]);

    status = 503;
    await pass(2);
    const down = (await client.uptimeClient.listMonitors(org)).find((m) => m.name === "shop.example.com")!;
    expect(down.state).toBe("down");
    // Down, but not for 3 minutes yet.
    await pass(2);
    await flush();
    expect(emitted()).toEqual([]);

    // The incidents open once it has held; the notification waits a minute so a burst goes out together.
    await pass(1);
    expect((await sql`select 1 from incident where state = 'open'`).length).toBe(3);
    await flush();
    expect(emitted()).toEqual([]);
    await pass(1);
    await flush();
    const opened = emitted().filter((e) => e.type === "system.service-down");
    expect(opened).toHaveLength(1);
    expect(opened[0].subject).toBe("Vardo: 3 monitors down");
    expect(opened[0].message).toBe("- shop-pr-7.example.com\n- shop.example.com\n- Vardo console");
    expect(JSON.stringify(opened)).not.toContain("mon_");

    await pass(3);
    await flush();
    expect(emitted().filter((e) => e.type === "system.service-down")).toHaveLength(1);

    status = 200;
    await pass(4);
    await pass(1);
    await flush();
    const resolved = emitted().filter((e) => e.type === "alert.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].alerts).toHaveLength(3);
    expect((await sql`select 1 from incident where state = 'open'`).length).toBe(0);
  });

  it("stays quiet while muted or in maintenance", async () => {
    h.emitted.length = 0;
    const [web] = (await client.uptimeClient.listMonitors(org)).filter((m) => !m.preview);
    await client.uptimeClient.setMuted(org, web.id, true);
    const preview = (await client.uptimeClient.listMonitors(org)).find((m) => m.preview)!;
    await client.uptimeClient.updateMonitor(org, preview.id, { maintenance: [{ start: t, end: t + 3_600_000 }] });
    status = 500;
    await pass(3);
    expect(emitted()).toEqual([]);
    status = 200;
    await pass(1);
  });

  it("rolls results into hourly and daily buckets and serves detail", async () => {
    await engine.rollup(t);
    const [web] = (await client.uptimeClient.listMonitors(org)).filter((m) => !m.preview);
    const list = (await client.uptimeClient.listMonitors(org)).find((m) => m.id === web.id)!;
    expect(list.daily).toHaveLength(30);
    const today = list.daily.at(-1)!;
    expect(today.minutesUp).toBeGreaterThan(0);
    expect(today.minutesDown).toBeGreaterThan(0);

    const detail = (await client.uptimeClient.getMonitor(org, web.id))!;
    expect(detail.daily90).toHaveLength(90);
    expect(detail.vantages[0]).toMatchObject({ kind: "local", signedAt: expect.any(Number) });
    expect(detail.outages.length).toBeGreaterThan(0);
    expect(await client.uptimeClient.getMonitor({ kind: "org", orgId: "other" }, web.id)).toBeNull();
    const signed = await sql`select record, sig from uptime_hourly limit 1`;
    expect(signed[0].sig).toBeTruthy();
  });

  it("reports domain reachability through the client, confirmed after two failures", async () => {
    const reach = async () => (await client.uptimeClient.domainReachability("org1", ["dom1"]))[0];
    status = 200;
    await pass(2);
    expect(await reach()).toMatchObject({ domainId: "dom1", reachable: true, confirmedUnreachable: false, statusCode: 200, error: null });

    status = 503;
    await pass(1);
    expect(await reach()).toMatchObject({ reachable: false, confirmedUnreachable: false });
    await pass(1);
    expect(await reach()).toMatchObject({ reachable: false, confirmedUnreachable: true, statusCode: 503, error: "unexpected status" });
    status = 200;
    await pass(1);
    expect(await reach()).toMatchObject({ reachable: true, confirmedUnreachable: false });

    expect(await client.uptimeClient.domainReachability("org1", [])).toEqual([]);
    expect(await client.uptimeClient.domainReachability("other", ["dom1"])).toEqual([]);
  });

  it("covers system-managed apps' domains, and pauses domain monitors when the domain-monitoring flag is off", async () => {
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, is_system_managed) values ('sys', 'org1', 'proj1', 'sys', 'Sys', 'active', true)`;
    await sql`insert into domain (id, app_id, domain, is_primary) values ('dom-sys', 'sys', 'tools.example.com', true)`;
    expect(await engine.syncAutoMonitors()).toEqual({ added: 1, removed: 0 });
    expect((await client.uptimeClient.domainReachability("org1", ["dom-sys"])).length).toBe(1);

    process.env.VARDO_FEATURE_DOMAIN_MONITORING = "0";
    try {
      expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
      expect((await client.uptimeClient.listMonitors(org)).length).toBe(3);
    } finally {
      delete process.env.VARDO_FEATURE_DOMAIN_MONITORING;
    }
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
    await sql`delete from app where id = 'sys'`;
    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
  });

  it("removes an auto monitor with its domain and refuses to delete it by hand", async () => {
    const web = (await client.uptimeClient.listMonitors(org)).find((m) => !m.preview)!;
    expect(await client.uptimeClient.deleteMonitor(org, web.id)).toBe("auto");
    await expect(client.uptimeClient.updateMonitor(org, web.id, { url: "https://elsewhere.example.com" })).rejects.toThrow();
    await sql`delete from environment where id = 'env1'`;
    await sql`delete from domain where id = 'dom1'`;
    expect(await client.uptimeClient.listMonitors(org)).toEqual([]);
  });

  it("creates, edits and deletes a manual monitor", async () => {
    const created = await client.uptimeClient.createMonitor(org, { type: "tcp", host: "db.example.com", port: 5432 });
    expect(created).toMatchObject({ source: "manual", target: "db.example.com:5432", intervalSec: 60 });
    const edited = await client.uptimeClient.updateMonitor(org, created.id, { port: 5433, intervalSec: 30 });
    expect(edited).toMatchObject({ target: "db.example.com:5433", intervalSec: 30 });
    expect(await client.uptimeClient.deleteMonitor(org, created.id)).toBe("deleted");
  });

  it("refuses an org monitor aimed at a private, loopback or link-local address", async () => {
    await expect(client.uptimeClient.createMonitor(org, { type: "http", url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(/isn't allowed/);
    await expect(client.uptimeClient.createMonitor(org, { type: "tcp", host: "10.99.0.2", port: 22 })).rejects.toThrow(/isn't allowed/);
    const ok = await client.uptimeClient.createMonitor(org, { type: "tcp", host: "93.184.216.34", port: 443 });
    await expect(client.uptimeClient.updateMonitor(org, ok.id, { host: "127.0.0.1" })).rejects.toThrow(/isn't allowed/);
    await client.uptimeClient.deleteMonitor(org, ok.id);
  });
});
