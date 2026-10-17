// Check load and detection accuracy against a scratch Postgres: homepage backoff, image paths, Vardo's catch-all,
// stopped apps, check methods, caches and heavy pages. Skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

const h = vi.hoisted(() => ({ opened: [] as string[], resolved: [] as string[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({ emit: () => {} }));
vi.mock("@/lib/uptime/outbound", async (orig) => ({
  ...(await orig<typeof import("@/lib/uptime/outbound")>()),
  checkDeps: async () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), guard: async () => null }),
  targetRefusal: async () => null,
}));
vi.mock("@/lib/incidents/uptime", async (orig) => ({
  ...(await orig<typeof import("@/lib/incidents/uptime")>()),
  openUptimeIncident: async (o: { about: string }) => void h.opened.push(o.about),
  resolveUptimeIncident: async (o: { about: string }) => (h.resolved.push(o.about), true),
}));
vi.mock("@/lib/activity/record", () => ({ recordActivity: async () => {} }));

const conn = await connectScratchServer();

const HOME = "<html>" + "home ".repeat(800) + "</html>";
const html = (body = HOME, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "text/html", ...(init.headers ?? {}) } });
type Seen = { url: string; method: string };

describe.skipIf(!conn)("uptime load and detection on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("uptime_load");
  let sql: ReturnType<typeof postgres>;
  let engine: typeof import("@/lib/uptime/engine");
  let health: typeof import("@/lib/uptime/health");
  let client: typeof import("@/lib/uptime/client");
  let serve: typeof import("@/lib/uptime/serve");
  const org = { kind: "org", orgId: "org1" } as const;
  const seen: Seen[] = [];
  let respond: (path: string, method: string) => Response = () => html();
  let t = Date.UTC(2026, 0, 10, 12, 0, 0);

  const mon = async (domainId = "dom1") => (await sql`select * from uptime_monitor where source = 'auto' and domain_id = ${domainId}`)[0];
  const summary = async (domainId = "dom1") => (await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === domainId)!;
  const detect = () => health.runHealthDetection(t);
  const dueNow = (domainId = "dom1") => sql`update uptime_monitor set health_due_at = null, review_answer = null, review_status = null, review_reason = null where domain_id = ${domainId}`;
  const minutes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      t += 60_000;
      vi.setSystemTime(t);
      await engine.runDueChecks(t, () => t);
    }
  };
  const checksOf = (host: string) => seen.filter((s) => new URL(s.url).host === host).length;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('proj1', 'org1', 'home', 'Home')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, last_running_at) values ('app1', 'org1', 'proj1', 'shop', 'Shop', 'active', now())`;
    await sql`insert into app (id, organization_id, project_id, name, display_name, status, last_running_at) values ('app2', 'org1', 'proj1', 'jellyfin', 'Jellyfin', 'active', now())`;
    await sql`insert into domain (id, app_id, domain, is_primary) values ('dom1', 'app1', 'shop.example.com', true)`;
    await sql`insert into domain (id, app_id, domain, is_primary) values ('dom2', 'app2', 'media.example.com', true)`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      seen.push({ url, method });
      return respond(new URL(url).pathname, method);
    });
    engine = await import("@/lib/uptime/engine");
    health = await import("@/lib/uptime/health");
    client = await import("@/lib/uptime/client");
    serve = await import("@/lib/uptime/serve");
    health.probeSpacing.gapMs = 0;
    await engine.syncAutoMonitors();
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  describe("homepage backoff", () => {
    it("checks a homepage fallback every 5 minutes and a health endpoint every minute", async () => {
      respond = () => html();
      await detect();
      expect(await mon()).toMatchObject({ health_source: "homepage", interval_sec: 300 });
      seen.length = 0;
      await minutes(10);
      expect(checksOf("shop.example.com")).toBe(2);

      respond = (path) => (path === "/healthz" ? Response.json({ ok: true }) : html());
      await dueNow();
      await detect();
      expect(await mon()).toMatchObject({ health_source: "probe", health_path: "/healthz", interval_sec: 60 });
      seen.length = 0;
      await minutes(10);
      expect(checksOf("shop.example.com")).toBe(10);
    });

    it("updates an existing homepage row on the next sync, and an operator's interval wins", async () => {
      await sql`update uptime_monitor set health_source = 'homepage', health_path = null, interval_sec = 60 where domain_id = 'dom1'`;
      await engine.syncAutoMonitors();
      expect((await mon()).interval_sec).toBe(300);

      const id = (await mon()).id;
      await client.uptimeClient.updateMonitor(org, id, { intervalSec: 30 });
      await engine.syncAutoMonitors();
      expect((await mon()).interval_sec).toBe(30);
      await client.uptimeClient.updateMonitor(org, id, { resetOverrides: true });
      expect((await mon()).interval_sec).toBe(300);
    });
  });

  describe("image health paths", () => {
    it("tries the image's known path before the generic list and takes a registry's 401", async () => {
      await sql`update app set image_name = 'registry:2' where id = 'app1'`;
      respond = (path) => (path === "/v2/" ? new Response("{}", { status: 401, headers: { "content-type": "application/json" } }) : html());
      await dueNow();
      seen.length = 0;
      await detect();
      expect(await mon()).toMatchObject({ health_path: "/v2/", health_source: "image", interval_sec: 60 });
      expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/", "/v2/"]);
    });

    it("reads images from the compose service the domain routes to", async () => {
      await sql`update app set image_name = null, compose_content = ${"services:\n  server:\n    image: ghcr.io/goauthentik/server:2025.2\n  worker:\n    image: postgres:17\n"} where id = 'app1'`;
      respond = (path) => (path === "/-/health/live/" ? new Response(null, { status: 200 }) : html());
      await dueNow();
      await detect();
      expect(await mon()).toMatchObject({ health_path: "/-/health/live/", health_source: "image" });
      await sql`update app set compose_content = null where id = 'app1'`;
    });

    it("costs no more requests than before when the image is unknown", async () => {
      respond = () => html();
      await dueNow();
      seen.length = 0;
      await detect();
      expect(seen).toHaveLength(1 + 9);
    });
  });

  describe("Vardo's catch-all", () => {
    const catchAll = () => new Response("there's nothing here", { status: 404, headers: { "content-type": "text/html", "x-vardo-route": "none" } });

    it("doesn't ask for review or probe paths when the host has no route", async () => {
      respond = catchAll;
      await dueNow();
      seen.length = 0;
      await detect();
      const row = await mon();
      expect(row.review_status).toBeNull();
      expect(seen).toHaveLength(1);
      expect(row.health_due_at.getTime()).toBeGreaterThan(t);
    });

    it("counts the catch-all as down, while the app's own 404 still counts as up", async () => {
      await sql`update uptime_monitor set interval_sec = 60 where domain_id = 'dom1'`;
      respond = catchAll;
      await minutes(4);
      expect(await summary()).toMatchObject({ state: "down" });
      respond = () => new Response("not here", { status: 404 });
      await minutes(4);
      expect((await summary()).state).toBe("up");
    });
  });

  describe("stopped apps", () => {
    it("shows an app the operator stopped as stopped: no checks, no review, no alert", async () => {
      respond = () => html();
      await detect();
      await sql`update app set status = 'stopped', parked = true where id = 'app2'`;
      await sql`update uptime_monitor set review_status = 404, review_reason = 'status', interval_sec = 60 where domain_id = 'dom2'`;
      await engine.syncAutoMonitors();
      expect(await mon("dom2")).toMatchObject({ review_status: null });
      seen.length = 0;
      h.opened.length = 0;
      await minutes(5);
      await engine.syncAllAlerts(t);
      expect(checksOf("media.example.com")).toBe(0);
      expect(h.opened).toEqual([]);
      expect(await summary("dom2")).toMatchObject({ state: "stopped", review: null });
      expect(await client.uptimeClient.listReviews("org1")).toEqual([]);
      expect((await client.uptimeClient.getAppUptime("org1", "app2")).state).toBe("stopped");
      const stoppedId = (await mon("dom2")).id;
      expect((await serve.buildWatchEntries(async () => ["93.184.216.34"])).some((e) => e.monitorId === stoppedId)).toBe(false);
    });

    it("treats a never-started app with no container as stopped", async () => {
      await sql`update app set status = 'missing', parked = false, last_running_at = null where id = 'app2'`;
      expect((await summary("dom2")).state).toBe("stopped");
    });

    it("keeps checking and alerts when the container crashed or vanished while Vardo meant it to run", async () => {
      for (const state of [sql`update app set status = 'error', parked = false, last_running_at = now() where id = 'app2'`, sql`update app set status = 'missing', parked = false, last_running_at = now() where id = 'app2'`]) {
        await state;
        respond = (path) => (path === "/" ? new Response("down", { status: 502 }) : html());
        seen.length = 0;
        await minutes(5);
        expect(checksOf("media.example.com")).toBeGreaterThan(0);
        expect((await summary("dom2")).state).toBe("down");
      }
    });

    it("counts stopped time as unknown, not down", async () => {
      await sql`update app set status = 'stopped', parked = true where id = 'app2'`;
      const id = (await mon("dom2")).id;
      await sql`delete from uptime_result where monitor_id = ${id}`;
      await minutes(30);
      await engine.rollup(t);
      const [hour] = await sql`select * from uptime_hourly where monitor_id = ${id} order by start desc limit 1`;
      expect(hour?.minutes_down ?? 0).toBe(0);
    });
  });

  describe("check methods", () => {
    it("takes POST and 401 as the answer and checks with them", async () => {
      await sql`update app set status = 'active', parked = false where id = 'app2'`;
      const id = (await mon("dom2")).id;
      respond = (path, method) => (path === "/heroku/api/v1/drain" ? new Response(null, { status: method === "POST" ? 401 : 404 }) : html());
      await expect(client.uptimeClient.answerReview(org, id, { kind: "path", path: "/heroku/api/v1/drain", method: "GET", status: 401 })).rejects.toThrow(/didn't answer 401/);
      expect(await client.uptimeClient.answerReview(org, id, { kind: "path", path: "/heroku/api/v1/drain", method: "POST", status: 401 })).toBe(true);
      const row = await mon("dom2");
      expect(row.check).toMatchObject({ url: "https://media.example.com/heroku/api/v1/drain", method: "POST", expectedStatus: { min: 401, max: 401 } });

      await engine.syncAutoMonitors();
      expect((await mon("dom2")).check.method).toBe("POST");
      seen.length = 0;
      await minutes(3);
      expect(seen.filter((s) => s.url.includes("/drain")).every((s) => s.method === "POST")).toBe(true);
      expect((await summary("dom2")).state).toBe("up");
      const entry = (await serve.buildWatchEntries(async () => ["93.184.216.34"])).find((e) => e.monitorId === id)!;
      expect(entry.check).toMatchObject({ method: "POST" });
      const { watchEntrySchema } = await import("@/lib/uptime/link");
      expect(watchEntrySchema.parse(entry).check).toMatchObject({ method: "POST" });
    });
  });

  describe("caches", () => {
    it("prefers an uncached health path", async () => {
      respond = (path) =>
        path === "/healthz"
          ? Response.json({ ok: 1 }, { headers: { "cf-cache-status": "HIT" } })
          : path === "/health"
            ? Response.json({ ok: 1 }, { headers: { "cf-cache-status": "DYNAMIC" } })
            : html();
      await dueNow();
      await detect();
      expect((await mon()).health_path).toBe("/health");
    });

    it("records a cached answer and says so on the monitor, still counting it as up", async () => {
      respond = () => Response.json({ ok: 1 }, { headers: { "cf-cache-status": "HIT", age: "30" } });
      await minutes(3);
      expect(await summary()).toMatchObject({ state: "up", cachedBy: "cloudflare" });
      const [r] = await sql`select cache from uptime_result where monitor_id = ${(await mon()).id} order by at desc limit 1`;
      expect(r.cache).toBe("cloudflare");
    });
  });

  describe("heavy checks", () => {
    it("flags a heavy homepage, offers the container healthcheck and stays dismissed", async () => {
      await sql`update app set compose_content = ${"services:\n  web:\n    image: nginx\n    healthcheck:\n      test: [\"CMD-SHELL\", \"curl -f http://localhost:3000/api/ready || exit 1\"]\n"} where id = 'app1'`;
      const id = (await mon()).id;
      await client.uptimeClient.updateMonitor(org, id, { path: "" });
      await sql`update uptime_monitor set interval_sec = 60 where id = ${id}`;
      respond = () => html("x".repeat(412 * 1024), { headers: { "content-length": String(412 * 1024) } });
      await minutes(4);
      const detail = await client.uptimeClient.getMonitor(org, id);
      expect(detail!.heavy).toMatchObject({ heavy: true, bytes: 412 * 1024, atLeast: false, offer: { path: "/api/ready", source: "healthcheck" } });

      await client.uptimeClient.updateMonitor(org, id, { heavyNoticeDismissed: true });
      expect((await client.uptimeClient.getMonitor(org, id))!.heavy).toBeNull();
      await engine.syncAutoMonitors();
      expect((await client.uptimeClient.getMonitor(org, id))!.heavy).toBeNull();
    });

    it("doesn't flag a small fast endpoint", async () => {
      const id = (await mon()).id;
      await client.uptimeClient.updateMonitor(org, id, { heavyNoticeDismissed: false });
      await sql`delete from uptime_result where monitor_id = ${id}`;
      respond = () => Response.json({ ok: 1 });
      await minutes(4);
      expect((await client.uptimeClient.getMonitor(org, id))!.heavy).toBeNull();
    });
  });
});
