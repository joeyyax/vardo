// The uptime engine against a scratch Postgres: auto monitors, checks, rollups and incidents.
// Skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

const h = vi.hoisted(() => ({ emitted: [] as { orgId: string; type: string; incident?: { state: string } }[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({
  emit: (orgId: string, event: { type: string; incident?: { state: string } }) => void h.emitted.push({ orgId, type: event.type, incident: event.incident }),
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
  // The console monitor shares the stubbed fetch; its incidents aren't under test.
  const emitted = () => h.emitted.filter((e) => (e.incident as { subject?: { id: string } } | undefined)?.subject?.id !== "mon_console");

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

  it("opens an incident after two failures and resolves on recovery", async () => {
    await pass(2);
    const up = await client.uptimeClient.listMonitors(org);
    expect(up.every((m) => m.state === "up" && m.localOnly)).toBe(true);
    expect(emitted().filter((e) => e.incident?.state === "open")).toEqual([]);

    status = 503;
    await pass(1);
    expect(emitted()).toEqual([]);
    await pass(1);
    const down = (await client.uptimeClient.listMonitors(org)).find((m) => m.name === "shop.example.com")!;
    expect(down.state).toBe("down");
    const opened = emitted().filter((e) => e.type === "system.service-down");
    expect(opened).toHaveLength(2);
    expect(opened[0].incident?.state).toBe("open");

    await pass(3);
    expect(emitted().filter((e) => e.type === "system.service-down")).toHaveLength(2);

    status = 200;
    await pass(1);
    expect(emitted().filter((e) => e.type === "alert.resolved")).toHaveLength(2);
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

  it("removes an auto monitor with its domain and refuses to delete it by hand", async () => {
    const web = (await client.uptimeClient.listMonitors(org)).find((m) => !m.preview)!;
    expect(await client.uptimeClient.deleteMonitor(org, web.id)).toBe("auto");
    await expect(client.uptimeClient.updateMonitor(org, web.id, { name: "Renamed" })).rejects.toThrow();
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
});
