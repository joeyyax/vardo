// Health endpoint detection, the review question and request headers against a scratch Postgres.
// Skips without a Postgres it can create databases on.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

type Emitted = { orgId: string; type: string };
const h = vi.hoisted(() => ({ emitted: [] as Emitted[] }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/notifications/dispatch", () => ({ emit: (orgId: string, event: Emitted) => void h.emitted.push({ orgId, type: event.type }) }));
vi.mock("@/lib/uptime/outbound", async (orig) => ({
  ...(await orig<typeof import("@/lib/uptime/outbound")>()),
  checkDeps: async () => ({ fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args), guard: async () => null }),
  targetRefusal: async () => null,
}));
vi.mock("@/lib/activity/record", () => ({ recordActivity: async () => {} }));

const conn = await connectScratchServer();

const HOME = "<html>" + "home ".repeat(800) + "</html>";
type Seen = { url: string; headers: Headers };

describe.skipIf(!conn)("uptime health detection on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("uptime_health");
  let sql: ReturnType<typeof postgres>;
  let engine: typeof import("@/lib/uptime/engine");
  let health: typeof import("@/lib/uptime/health");
  let client: typeof import("@/lib/uptime/client");
  let serve: typeof import("@/lib/uptime/serve");
  const org = { kind: "org", orgId: "org1" } as const;
  const seen: Seen[] = [];
  let respond: (path: string) => Response = () => new Response(HOME, { headers: { "content-type": "text/html" } });
  let t = Date.UTC(2026, 0, 10, 12, 0, 0);

  const monitorRow = async (id: string) => (await sql`select * from uptime_monitor where id = ${id}`)[0];
  const autoMonitor = async () => (await sql`select * from uptime_monitor where source = 'auto' and domain_id = 'dom1'`)[0];
  const detect = () => health.runHealthDetection(t);
  const pass = async () => {
    t += 60_000;
    vi.setSystemTime(t);
    await engine.runDueChecks(t, () => t);
  };
  const dueNow = () => sql`update uptime_monitor set health_due_at = null where domain_id = 'dom1'`;

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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, headers: new Headers(init?.headers) });
      return respond(new URL(url).pathname);
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

  it("picks a health path that differs from the homepage and keeps it through auto-sync", async () => {
    respond = (path) => (path === "/health" ? Response.json({ status: "ok" }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
    seen.length = 0;
    expect(await detect()).toBe(1);
    const row = await autoMonitor();
    expect(row).toMatchObject({ health_path: "/health", health_source: "probe", review_status: null });
    expect(row.check.url).toBe("https://shop.example.com/health");
    // Tried in order: the homepage, then /healthz and /health.
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/", "/healthz", "/health"]);
    expect(row.health_due_at.getTime()).toBeGreaterThan(t + 23 * 3_600_000);

    expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
    expect((await autoMonitor()).check.url).toBe("https://shop.example.com/health");
    const summary = (await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === "dom1")!;
    expect(summary).toMatchObject({ healthPath: "/health", healthSource: "probe", target: "https://shop.example.com/health" });

    // Not again until the day is up.
    seen.length = 0;
    expect(await detect()).toBe(0);
    expect(seen).toEqual([]);
  });

  it("sends Cache-Control: no-cache on every request", async () => {
    await pass();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.headers.get("cache-control") === "no-cache")).toBe(true);
  });

  it("falls back to the homepage when every path serves the homepage", async () => {
    respond = () => new Response(HOME, { headers: { "content-type": "text/html" } });
    await dueNow();
    seen.length = 0;
    await detect();
    const row = await autoMonitor();
    expect(row).toMatchObject({ health_path: null, health_source: "homepage", review_status: null });
    expect(row.check.url).toBe("https://shop.example.com");
    expect(seen).toHaveLength(1 + 9);
  });

  it("does not take a large HTML page, a 404 or a redirect to the homepage as a health endpoint", async () => {
    respond = (path) => (path === "/" ? new Response(HOME, { headers: { "content-type": "text/html" } }) : path === "/up" ? new Response(HOME + "x", { headers: { "content-type": "text/html" } }) : new Response("nope", { status: 404 }));
    await dueNow();
    await detect();
    expect(await autoMonitor()).toMatchObject({ health_path: null, health_source: "homepage" });
  });

  it("prefers the path in the app's compose healthcheck", async () => {
    await sql`update app set compose_content = ${"services:\n  web:\n    image: nginx\n    healthcheck:\n      test: [\"CMD-SHELL\", \"curl -f http://localhost:3000/api/ready || exit 1\"]\n"} where id = 'app1'`;
    respond = (path) => (path === "/api/ready" || path === "/healthz" ? Response.json({ ok: true }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
    await dueNow();
    seen.length = 0;
    await detect();
    expect(await autoMonitor()).toMatchObject({ health_path: "/api/ready", health_source: "healthcheck" });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/", "/api/ready"]);
    await sql`update app set compose_content = null where id = 'app1'`;
  });

  it("looks again after a deploy, but not for a manual monitor", async () => {
    const manual = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://api.example.com/status" });
    const before = (await monitorRow(manual.id)).check.url;
    await client.uptimeClient.requestHealthDetection("app1");
    expect((await autoMonitor()).health_due_at).toBeNull();
    respond = (path) => (path === "/healthz" ? new Response("ok", { headers: { "content-type": "text/plain" } }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
    await detect();
    expect(await autoMonitor()).toMatchObject({ health_path: "/healthz" });
    expect((await monitorRow(manual.id)).check.url).toBe(before);
    expect(await monitorRow(manual.id)).toMatchObject({ health_path: null, health_source: null, health_due_at: null });
    await client.uptimeClient.deleteMonitor(org, manual.id);
  });

  it("spaces probes so one instance sends at most a few requests a second", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    for (let i = 0; i < 6; i++) await health.spaced(350, sleep);
    // The first goes at once; each next waits out the gap, however fast the callers are.
    expect(waits).toHaveLength(5);
    waits.forEach((ms, i) => expect(ms).toBeGreaterThan(350 * (i + 1) - 50));
    expect(health.PROBE_GAP_MS).toBeGreaterThanOrEqual(333);
    health.resetSpacing();
  });

  it("offers the uptime health path as the container healthcheck, and only when the app has none", async () => {
    await sql`update uptime_monitor set health_path = '/healthz', health_source = 'probe' where domain_id = 'dom1'`;
    await sql`update app set container_port = 3000, compose_content = ${"services:\n  web:\n    image: nginx\n"} where id = 'app1'`;
    expect(await health.containerHealthFor("org1", "app1")).toEqual({ hasHealthcheck: false, path: null, offerPath: "/healthz" });

    expect(await health.adoptContainerHealthcheck("org1", "app1")).toBe(true);
    const [app] = await sql`select compose_content, needs_redeploy from app where id = 'app1'`;
    expect(app.needs_redeploy).toBe(true);
    expect(app.compose_content).toContain("http://localhost:3000/healthz");
    expect(await health.containerHealthFor("org1", "app1")).toEqual({ hasHealthcheck: true, path: "/healthz", offerPath: null });
    expect(await health.adoptContainerHealthcheck("org1", "app1")).toBe(false);
    expect(await health.adoptContainerHealthcheck("other", "app1")).toBe(false);

    await sql`update app set compose_content = null, needs_redeploy = false where id = 'app1'`;
    await sql`update uptime_monitor set health_path = null, health_source = null where domain_id = 'dom1'`;
  });

  it("detects for a URL without saving anything", async () => {
    respond = (path) => (path === "/livez" ? Response.json({ ok: 1 }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
    const found = await client.uptimeClient.detectHealth(org, "https://other.example.com");
    expect(found).toMatchObject({ found: true, path: "/livez", source: "probe", url: "https://other.example.com/livez" });
    respond = () => new Response(HOME, { headers: { "content-type": "text/html" } });
    expect(await client.uptimeClient.detectHealth(org, "https://other.example.com")).toMatchObject({ found: false, source: "homepage", path: null });
    expect((await sql`select count(*)::int as n from uptime_monitor where name like '%other.example.com%'`)[0].n).toBe(0);
  });

  describe("the review question", () => {
    it("marks a monitor that answers 401 as needing review: no alert, unknown in the math", async () => {
      h.emitted.length = 0;
      respond = () => new Response("login required", { status: 401, headers: { "content-type": "text/plain" } });
      await dueNow();
      await detect();
      expect(await autoMonitor()).toMatchObject({ review_status: 401, review_reason: "status", health_source: "homepage" });
      // A tiny login body would qualify as a health path if it differed; it doesn't, it's a 401.
      const summary = (await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === "dom1")!;
      expect(summary).toMatchObject({ state: "review", review: { status: 401, reason: "status" } });

      for (let i = 0; i < 6; i++) await pass();
      await engine.rollup(t);
      const app = await client.uptimeClient.getAppUptime("org1", "app1");
      expect(app.state).toBe("unknown");
      expect(app.reviews.map((m) => m.id)).toEqual([summary.id]);
      const day = (await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === "dom1")!.daily.at(-1)!;
      expect(day.minutesUp + day.minutesDown).toBe(0);
      expect(h.emitted).toEqual([]);
      expect((await client.uptimeClient.listReviews("org1")).map((r) => [r.name, r.status])).toEqual([["shop.example.com", 401]]);
    });

    it("keeps counting 500 and up as down", async () => {
      await sql`update uptime_monitor set review_status = null, review_reason = null, interval_sec = 60 where domain_id = 'dom1'`;
      respond = () => new Response("boom", { status: 503 });
      for (let i = 0; i < 4; i++) await pass();
      expect((await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === "dom1")!.state).toBe("down");
    });

    it("stores the answer, and it survives re-detection and auto-sync", async () => {
      await sql`update uptime_monitor set review_status = 401, review_reason = 'status' where domain_id = 'dom1'`;
      const id = (await autoMonitor()).id;
      expect(await client.uptimeClient.answerReview(org, id, { kind: "status", status: 401 })).toBe(true);
      expect(await autoMonitor()).toMatchObject({ review_status: null, review_answer: { kind: "status", status: 401 } });
      expect((await autoMonitor()).check.expectedStatus).toEqual({ min: 401, max: 401 });

      await sql`update uptime_monitor set health_due_at = null where id = ${id}`;
      respond = (path) => (path === "/healthz" ? Response.json({ ok: 1 }) : new Response("login", { status: 401, headers: { "content-type": "text/plain" } }));
      expect(await detect()).toBe(0);
      expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
      expect(await autoMonitor()).toMatchObject({ health_path: null, review_answer: { kind: "status", status: 401 } });
      expect((await autoMonitor()).check.expectedStatus).toEqual({ min: 401, max: 401 });

      for (let i = 0; i < 3; i++) await pass();
      expect((await client.uptimeClient.listMonitors(org)).find((m) => m.domainId === "dom1")!.state).toBe("up");
    });

    it("takes a health path as the answer, after checking it answers 2xx", async () => {
      const id = (await autoMonitor()).id;
      await sql`update uptime_monitor set review_answer = null, review_status = 401, review_reason = 'status' where id = ${id}`;
      respond = (path) => (path === "/status/ready" ? Response.json({ ok: 1 }) : new Response("login", { status: 401 }));
      await expect(client.uptimeClient.answerReview(org, id, { kind: "path", path: "/missing" })).rejects.toThrow(/didn't answer 2xx/);
      await expect(client.uptimeClient.answerReview(org, id, { kind: "path", path: "no-slash" })).rejects.toThrow(/starts with/);
      expect(await client.uptimeClient.answerReview(org, id, { kind: "path", path: "/status/ready" })).toBe(true);
      expect(await autoMonitor()).toMatchObject({ health_path: "/status/ready", health_source: "probe", review_status: null, review_answer: { kind: "path", path: "/status/ready" } });
      expect((await autoMonitor()).check.url).toBe("https://shop.example.com/status/ready");
      expect((await autoMonitor()).check.expectedStatus).toEqual({ min: 100, max: 499 });
      await engine.syncAutoMonitors();
      expect((await autoMonitor()).check.url).toBe("https://shop.example.com/status/ready");
    });

    it("turns the monitor off for 'don't monitor this domain', and sync leaves it off", async () => {
      const id = (await autoMonitor()).id;
      expect(await client.uptimeClient.answerReview(org, id, { kind: "skip" })).toBe(true);
      await engine.syncAutoMonitors();
      expect(await autoMonitor()).toMatchObject({ enabled: false, review_answer: { kind: "skip" } });
      await sql`update uptime_monitor set enabled = true, review_answer = null where id = ${id}`;
    });

    it("refuses an answer for a manual monitor or another org's monitor", async () => {
      const manual = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://api.example.com" });
      expect(await client.uptimeClient.answerReview(org, manual.id, { kind: "skip" })).toBe(false);
      expect(await client.uptimeClient.answerReview({ kind: "org", orgId: "other" }, (await autoMonitor()).id, { kind: "skip" })).toBe(false);
      await client.uptimeClient.deleteMonitor(org, manual.id);
    });
  });

  describe("ranges", () => {
    const HOUR = 3_600_000;

    it("defaults to the smallest range that covers the history, and starts the bars where it starts", async () => {
      const id = (await autoMonitor()).id;
      const created = t - 5 * HOUR - 25 * 60_000;
      await sql`update uptime_monitor set created_at = ${new Date(created)} where id = ${id}`;
      await sql`delete from uptime_hourly where monitor_id = ${id}`;
      const hourStart = Math.floor(created / HOUR) * HOUR;
      for (let i = 0; i < 6; i++) {
        await sql`insert into uptime_hourly (monitor_id, start, minutes_up, minutes_down, minutes_unknown) values (${id}, ${new Date(hourStart + i * HOUR)}, ${i === 2 ? 45 : 60}, ${i === 2 ? 15 : 0}, 0)`;
      }

      const monitor = async (range?: "1h" | "24h" | "7d" | "30d" | "90d") => {
        const list = await client.uptimeClient.listMonitors(org, range);
        return list.find((m) => m.id === id)!;
      };

      const auto = await monitor();
      expect(auto).toMatchObject({ range: "24h", barMs: HOUR, since: created });
      // From the hour holding the creation time to the current hour.
      expect(auto.bars).toHaveLength(Math.floor(t / HOUR) - hourStart / HOUR + 1);
      expect(auto.bars[0].start).toBe(hourStart);
      expect(auto.rangeUptime).toBe(Math.round((345 / 360) * 10_000) / 100);

      // A shorter range than the history has every bar and no "since".
      const hour = await monitor("1h");
      expect(hour).toMatchObject({ range: "1h", barMs: 60_000, since: null });
      expect(hour.bars).toHaveLength(60);

      // Longer ranges start at the same moment: one or two daily bars, six-hour bars for a week.
      const week = await monitor("7d");
      expect(week).toMatchObject({ barMs: 6 * HOUR, since: created });
      expect(week.bars.length).toBeLessThanOrEqual(3);
      const month = await monitor("30d");
      expect(month.since).toBe(created);
      expect(month.bars.length).toBeLessThanOrEqual(2);

      // The monitor's detail and the app's tab agree.
      const detail = await client.uptimeClient.getMonitor(org, id, "7d");
      expect(detail).toMatchObject({ range: "7d", since: created });
      const app = await client.uptimeClient.getAppUptime("org1", "app1", "24h");
      expect(app).toMatchObject({ range: "24h", barMs: HOUR });
      expect(app.since).not.toBeNull();
      expect(app.bars.length).toBeLessThanOrEqual(7);
    });

    it("reads a year-old monitor over its whole range", async () => {
      const id = (await autoMonitor()).id;
      await sql`update uptime_monitor set created_at = ${new Date(t - 400 * 86_400_000)} where id = ${id}`;
      const m = (await client.uptimeClient.listMonitors(org)).find((x) => x.id === id)!;
      expect(m).toMatchObject({ range: "90d", since: null });
      expect(m.bars).toHaveLength(90);
    });
  });

  describe("edits to an automatic monitor", () => {
    it("keeps the host on the domain and stores edits as overrides that sync and detection leave alone", async () => {
      const id = (await autoMonitor()).id;
      await expect(client.uptimeClient.updateMonitor(org, id, { url: "https://evil.example.com" })).rejects.toThrow(/follows its domain/);
      await expect(client.uptimeClient.updateMonitor(org, id, { path: "no-slash" })).rejects.toThrow(/starts with/);

      const edited = await client.uptimeClient.updateMonitor(org, id, {
        name: "Shop front",
        path: "/custom",
        expectedStatus: { min: 200, max: 299 },
        keyword: "Welcome",
        timeoutMs: 5000,
        intervalSec: 300,
      });
      expect(edited).toMatchObject({ name: "Shop front", target: "https://shop.example.com/custom", intervalSec: 300, healthPath: "/custom" });
      expect(edited!.overrides).toEqual({ name: "Shop front", path: "/custom", expectedStatus: { min: 200, max: 299 }, keyword: "Welcome", timeoutMs: 5000, intervalSec: 300 });
      expect((await autoMonitor()).check).toMatchObject({ url: "https://shop.example.com/custom", expectedStatus: { min: 200, max: 299 }, keyword: "Welcome", timeoutMs: 5000 });

      // Sync keeps every edit, and detection doesn't touch a pinned path.
      expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
      await sql`update uptime_monitor set health_due_at = null where id = ${id}`;
      respond = (path) => (path === "/healthz" ? Response.json({ ok: 1 }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
      expect(await detect()).toBe(0);
      const row = await autoMonitor();
      expect(row).toMatchObject({ name: "Shop front", interval_sec: 300, health_path: "/custom" });
      expect(row.check).toMatchObject({ url: "https://shop.example.com/custom", expectedStatus: { min: 200, max: 299 }, keyword: "Welcome", timeoutMs: 5000 });
    });

    it("resets to automatic: edits cleared, detection runs again, the name follows the domain", async () => {
      const id = (await autoMonitor()).id;
      const reset = await client.uptimeClient.updateMonitor(org, id, { resetOverrides: true });
      expect(reset!.overrides).toBeNull();
      expect(await autoMonitor()).toMatchObject({ overrides: null, interval_sec: 60, health_path: null, health_due_at: null });
      await engine.syncAutoMonitors();
      const row = await autoMonitor();
      expect(row).toMatchObject({ name: "shop.example.com" });
      expect(row.check).toMatchObject({ url: "https://shop.example.com", expectedStatus: { min: 100, max: 499 }, timeoutMs: 10000 });
      expect(row.check.keyword).toBeUndefined();
      respond = (path) => (path === "/healthz" ? Response.json({ ok: 1 }) : new Response(HOME, { headers: { "content-type": "text/html" } }));
      await detect();
      expect(await autoMonitor()).toMatchObject({ health_path: "/healthz" });
    });

    it("an edited expected status stands in for the review question", async () => {
      const id = (await autoMonitor()).id;
      await client.uptimeClient.updateMonitor(org, id, { expectedStatus: { min: 401, max: 401 } });
      respond = () => new Response("login", { status: 401, headers: { "content-type": "text/plain" } });
      await sql`update uptime_monitor set health_due_at = null where id = ${id}`;
      await detect();
      expect(await autoMonitor()).toMatchObject({ review_status: null });
      await client.uptimeClient.updateMonitor(org, id, { resetOverrides: true });
    });
  });

  describe("manual checks linked to an app", () => {
    it("links a check to the app and domain, and sync never touches it", async () => {
      const keyword = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://shop.example.com/pricing", keyword: "Plans", appId: "app1", domainId: "dom1" });
      const tls = await client.uptimeClient.createMonitor(org, { type: "tls", host: "shop.example.com", appId: "app1", domainId: "dom1" });
      expect(keyword).toMatchObject({ source: "manual", appId: "app1", appName: "shop", domainId: "dom1", domainRemoved: false });
      expect(await engine.syncAutoMonitors()).toEqual({ added: 0, removed: 0 });
      expect((await client.uptimeClient.listMonitors(org)).filter((m) => m.source === "manual" && m.appId === "app1").map((m) => m.id).sort()).toEqual([keyword.id, tls.id].sort());

      const app = await client.uptimeClient.getAppUptime("org1", "app1");
      expect(app.monitors.map((m) => m.id)).toEqual(expect.arrayContaining([keyword.id, tls.id]));
      // The domain's automatic monitor is still there beside them.
      expect(app.monitors.some((m) => m.source === "auto" && m.domainId === "dom1")).toBe(true);
      expect(await client.uptimeClient.deleteMonitor(org, tls.id)).toBe("deleted");
      await client.uptimeClient.deleteMonitor(org, keyword.id);
    });

    it("keeps the check when the domain is removed, flagged, and removes it only when the operator deletes it", async () => {
      await sql`insert into domain (id, app_id, domain, is_primary) values ('dom2', 'app1', 'blog.example.com', false)`;
      const check = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://blog.example.com/feed", appId: "app1", domainId: "dom2" });
      expect(check.domainRemoved).toBe(false);
      await sql`delete from domain where id = 'dom2'`;
      await engine.syncAutoMonitors();
      const after = (await client.uptimeClient.listMonitors(org)).find((m) => m.id === check.id)!;
      expect(after).toMatchObject({ domainRemoved: true, source: "manual", appId: "app1" });
      expect(await client.uptimeClient.deleteMonitor(org, check.id)).toBe("deleted");
    });

    it("refuses a link to another org's app or a domain from another app", async () => {
      await sql`insert into organization (id, name, slug) values ('org2', 'Other', 'other')`;
      await sql`insert into project (id, organization_id, name, display_name) values ('proj2', 'org2', 'x', 'X')`;
      await sql`insert into app (id, organization_id, project_id, name, display_name, status) values ('app2', 'org2', 'proj2', 'x', 'X', 'active')`;
      await sql`insert into domain (id, app_id, domain, is_primary) values ('dom-x', 'app2', 'x.example.com', true)`;
      await expect(client.uptimeClient.createMonitor(org, { type: "tcp", host: "x.example.com", port: 443, appId: "app2" })).rejects.toThrow(/doesn't exist/);
      await expect(client.uptimeClient.createMonitor(org, { type: "tcp", host: "x.example.com", port: 443, appId: "app1", domainId: "dom-x" })).rejects.toThrow(/isn't on the app/);
      await expect(client.uptimeClient.createMonitor(org, { type: "tcp", host: "x.example.com", port: 443, domainId: "dom1" })).rejects.toThrow(/Choose the app/);
    });
  });

  describe("request headers", () => {
    const SECRET = "s3cr3t-token-value";
    let id = "";

    it("stores values encrypted, returns names only and sends them with checks", async () => {
      const created = await client.uptimeClient.createMonitor(org, { type: "http", url: "https://private.example.com/health", headers: [{ name: "X-Health-Token", value: SECRET }], basicAuth: { username: "me", password: "pw-value" } });
      id = created.id;
      expect(created.headers.sort()).toEqual(["Authorization", "X-Health-Token"]);
      expect(JSON.stringify(created)).not.toContain(SECRET);
      expect(JSON.stringify(created)).not.toContain("bWU6cHctdmFsdWU");

      const row = await monitorRow(id);
      expect(row.headers_encrypted).toMatch(/^enc:/);
      expect(row.headers_encrypted).not.toContain(SECRET);
      expect(JSON.stringify(row.check)).not.toContain(SECRET);
      expect(row.header_names).toEqual(["X-Health-Token", "Authorization"]);
      expect(row.share_headers).toBe(false);

      const detail = await client.uptimeClient.getMonitor(org, id);
      expect(JSON.stringify(detail)).not.toContain(SECRET);
      expect(JSON.stringify(await client.uptimeClient.listMonitors(org))).not.toContain(SECRET);

      respond = () => new Response("ok");
      seen.length = 0;
      await pass();
      const sent = seen.find((s) => s.url.startsWith("https://private.example.com"))!;
      expect(sent.headers.get("x-health-token")).toBe(SECRET);
      expect(sent.headers.get("authorization")).toBe("Basic bWU6cHctdmFsdWU=");
      expect(sent.headers.get("cache-control")).toBe("no-cache");
      // The auto monitor's check doesn't carry them.
      expect(seen.filter((s) => s.url.startsWith("https://shop.example.com")).every((s) => !s.headers.get("x-health-token"))).toBe(true);
    });

    it("keeps a stored value when an edit leaves it out, and removes what's dropped", async () => {
      const edited = await client.uptimeClient.updateMonitor(org, id, { headers: [{ name: "x-health-token" }, { name: "X-Other", value: "second" }] });
      expect(edited!.headers).toEqual(["x-health-token", "X-Other"]);
      respond = () => new Response("ok");
      seen.length = 0;
      await pass();
      const sent = seen.find((s) => s.url.startsWith("https://private.example.com"))!;
      expect(sent.headers.get("x-health-token")).toBe(SECRET);
      expect(sent.headers.get("x-other")).toBe("second");
      expect(sent.headers.get("authorization")).toBeNull();
      await expect(client.uptimeClient.updateMonitor(org, id, { headers: [{ name: "X-New" }] })).rejects.toThrow(/Enter a value for X-New/);
    });

    it("refuses blocked headers and too many", async () => {
      await expect(client.uptimeClient.updateMonitor(org, id, { headers: [{ name: "Host", value: "evil.example.com" }] })).rejects.toThrow(/can't be set/);
      await expect(client.uptimeClient.updateMonitor(org, id, { headers: Array.from({ length: 11 }, (_, i) => ({ name: `X-${i}`, value: "v" })) })).rejects.toThrow();
      await expect(client.uptimeClient.createMonitor(org, { type: "tcp", host: "db.example.com", port: 5432, headers: [{ name: "X-A", value: "v" }] })).rejects.toThrow(/HTTP checks only/);
    });

    it("keeps a monitor with private headers out of the watch list until the owner shares them", async () => {
      const resolve = async () => ["93.184.216.34"];
      const entry = async () => (await serve.buildWatchEntries(resolve)).find((e) => e.monitorId === id);

      expect(await entry()).toBeUndefined();
      expect((await client.uptimeClient.getMonitor(org, id))).toMatchObject({ privateHeader: true, shareHeaders: false });

      await client.uptimeClient.updateMonitor(org, id, { shareHeaders: true });
      const shared = await entry();
      expect(shared?.headers).toEqual({ "x-health-token": SECRET, "X-Other": "second" });
      expect(shared && JSON.stringify(shared.check)).not.toContain(SECRET);
      expect(await client.uptimeClient.getMonitor(org, id)).toMatchObject({ privateHeader: false, shareHeaders: true });

      await client.uptimeClient.updateMonitor(org, id, { shareHeaders: false });
      expect(await entry()).toBeUndefined();
      // A monitor without headers is unaffected.
      expect((await serve.buildWatchEntries(resolve)).some((e) => e.monitorId.startsWith("mon_"))).toBe(true);
    });

    it("clears every header with an empty set", async () => {
      const cleared = await client.uptimeClient.updateMonitor(org, id, { headers: [] });
      expect(cleared!.headers).toEqual([]);
      expect((await monitorRow(id)).headers_encrypted).toBeNull();
      await client.uptimeClient.deleteMonitor(org, id);
    });

    it("asking with headers re-runs detection, and the headers are sent to the probes", async () => {
      const mon = await autoMonitor();
      respond = () => new Response("login", { status: 401, headers: { "content-type": "text/plain" } });
      await sql`update uptime_monitor set review_status = 401, review_reason = 'status', review_answer = null, health_due_at = now() + interval '1 day' where id = ${mon.id}`;
      expect(await client.uptimeClient.answerReview(org, mon.id, { kind: "headers", headers: [{ name: "X-Health-Token", value: SECRET }] })).toBe(true);
      expect(await autoMonitor()).toMatchObject({ review_status: null, header_names: ["X-Health-Token"], health_due_at: null });
      expect((await autoMonitor()).headers_encrypted).not.toContain(SECRET);

      respond = () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      seen.length = 0;
      await detect();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s.headers.get("x-health-token") === SECRET)).toBe(true);
    });
  });
});
