import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));

import {
  PROBE_EVENTS_PER_WINDOW,
  carriedMarker,
  handleGuardRequest,
  originalPath,
  recordsProbeEvent,
  type GuardDeps,
} from "@/lib/probe-guard/respond";
import { DEFAULT_INSTANCE_PROBE_GUARD, type InstanceProbeGuard } from "@/lib/probe-guard/settings";
import { canaryValues } from "@/lib/probe-guard/canary";
import { renderAppRobots } from "@/lib/probe-guard/robots";
import { banRef } from "@/lib/probe-guard/ban-ref";
import type { BanRequest } from "@/lib/probe-guard/bans";

const KEY = "k".repeat(64);
const IP = "203.0.113.50";

function setup(over: Partial<InstanceProbeGuard> = {}, depsOver: Partial<GuardDeps> = {}) {
  const hits = new Map<string, number>();
  const bans: BanRequest[] = [];
  const events: { kind: string; ip: string; path?: string | null; canaryId?: string | null }[] = [];
  const settings = { ...DEFAULT_INSTANCE_PROBE_GUARD, ...over };
  const deps: GuardDeps = {
    hasKey: (v) => v === KEY,
    settings: async () => settings,
    clientIp: async () => IP,
    recordHit: async (ip) => {
      const n = (hits.get(ip) ?? 0) + 1;
      hits.set(ip, n);
      return n;
    },
    ban: async (req) => {
      bans.push(req);
      return { status: "refused", reason: "test" };
    },
    recordEvent: async (e) => {
      events.push(e);
    },
    markerFor: async () => ({ id: "c1", marker: "abcdefghjk23" }),
    activeMarkers: async () => [{ id: "c1", marker: "abcdefghjk23" }],
    markUsed: vi.fn(async () => {}),
    appForHost: async () => ({ id: "app1" }),
    robotsFor: renderAppRobots,
    ...depsOver,
  };
  return { deps, bans, events, hits };
}

function req(path: string, opts: { key?: string | null; app?: string; headers?: Record<string, string>; method?: string; query?: string; kind?: string } = {}) {
  const headers = new Headers({ "x-replaced-path": path, host: "shop.example.com", ...(opts.headers ?? {}) });
  if (opts.key !== null) headers.set("X-Vardo-Guard", opts.key ?? KEY);
  if (opts.app) headers.set("X-Vardo-Guard-App", opts.app);
  return new Request(`http://console/probe-guard/${opts.kind ?? "probe"}${opts.query ?? ""}`, { method: opts.method ?? "GET", headers });
}

describe("handleGuardRequest", () => {
  it("answers a plain 404 without Traefik's key", async () => {
    const { deps, bans } = setup();
    const res = await handleGuardRequest("probe", req("/.env", { key: null }), deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found\n");
    expect(bans).toHaveLength(0);
  });

  it("answers 404 for secrets and 403 for the rest, uncached, as plain text", async () => {
    const { deps } = setup();
    const env = await handleGuardRequest("probe", req("/.env", { app: "app1" }), deps);
    expect(env.status).toBe(404);
    expect(env.headers.get("cache-control")).toBe("no-store");
    expect(env.headers.get("content-type")).toMatch(/^text\/plain/);
    const wp = await handleGuardRequest("probe", req("/wp-login.php", { app: "app1" }), deps);
    expect(wp.status).toBe(403);
  });

  it("never echoes the host, path, app or headers", async () => {
    const { deps } = setup();
    const res = await handleGuardRequest("probe", req("/.env", { app: "secret-app-id", headers: { "user-agent": "scanner/1.0" } }), deps);
    const body = await res.text();
    for (const leak of ["shop.example.com", "secret-app-id", "scanner", ".env\n", IP]) expect(body).not.toContain(leak);
    expect(body.length).toBeLessThan(100);
  });

  it("answers a browser with a small page that names the status and leaks nothing", async () => {
    const { deps } = setup();
    const accept = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "scanner/1.0" };
    const res = await handleGuardRequest("probe", req("/wp-login.php", { app: "secret-app-id", headers: accept }), deps);
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(body).toContain("<title>403 Forbidden</title>");
    expect(body).toContain("This item is unavailable.");
    expect(body).not.toMatch(/<script/i);
    for (const leak of ["shop.example.com", "secret-app-id", "scanner", "wp-login", IP]) expect(body).not.toContain(leak);
  });

  it("words a ban and a missing page for people, and keeps text for non-browsers", async () => {
    const { deps } = setup();
    const html = { accept: "text/html" };
    const banned = await (await handleGuardRequest("banned", req("/", { headers: html }), deps)).text();
    expect(banned).toContain("Access from your address is unavailable right now.");
    const missing = await (await handleGuardRequest("probe", req("/.env", { headers: html }), deps)).text();
    expect(missing).toContain("<title>404 Not Found</title>");
    expect(missing).toContain("The page you requested is unavailable.");
    const api = await handleGuardRequest("probe", req("/.env", { headers: { accept: "application/json" } }), deps);
    expect(await api.text()).toBe("Not Found\n");
  });

  describe("banned page", () => {
    const html = { accept: "text/html" };
    const BAN_ID = "ban-id-xyz-123";
    const CREATED = new Date("2026-10-13T09:00:00Z");
    const ban = (expiresAt: Date, blocklist = false) => ({
      banLookup: async () => (ip: string) => (ip === IP ? { id: BAN_ID, blocklist, expiresAt, createdAt: CREATED } : undefined),
    });
    const in45 = () => new Date(Date.now() + 45 * 60_000);

    it("tells a banned visitor when the ban ends and nothing about why", async () => {
      const { deps } = setup({}, ban(in45()));
      const body = await (await handleGuardRequest("banned", req("/wp-login.php", { app: "secret-app-id", headers: html }), deps)).text();
      expect(body).toMatch(/Access from your address is unavailable until \d\d:\d\d UTC\./);
      for (const leak of ["threshold", "trap", "canary", "blocklist", "wp-login", "secret-app-id", BAN_ID, IP]) expect(body).not.toContain(leak);
    });

    it("gives the visitor a short reference an admin can search for", async () => {
      const { deps } = setup({}, ban(in45()));
      const res = await handleGuardRequest("banned", req("/", { headers: html }), deps);
      const body = await res.text();
      expect(body).toContain(`<span class="n">${banRef(BAN_ID, CREATED)}</span>`);
      expect(body).toMatch(/<span class="p">:<\/span> <span class="v"><span class="n">403<\/span><span class="p">-<\/span><span class="n">13-[2-9A-HJ-NP-Z]{4}<\/span>/);
      // The page stays inert: one CSP everywhere, no script allowed.
      expect(res.headers.get("content-security-policy")).not.toContain("script-src");
      const plain = await handleGuardRequest("probe", req("/.env", { headers: html }), deps);
      expect(plain.headers.get("content-security-policy")).toBe(res.headers.get("content-security-policy"));
    });

    it("gives no reference for a blocklist ban, which the admin list doesn't show", async () => {
      const { deps } = setup({}, ban(in45(), true));
      const body = await (await handleGuardRequest("banned", req("/", { headers: html }), deps)).text();
      expect(body).toContain("until");
      expect(body).not.toContain('class="v"');
    });

    it("says a permanent ban has no end date", async () => {
      const { deps } = setup({}, ban(new Date("9999-12-31T00:00:00.000Z")));
      const body = await (await handleGuardRequest("banned", req("/", { headers: html }), deps)).text();
      expect(body).toContain("there is no end date");
    });

    it("keeps the generic line when no active ban explains the block", async () => {
      const none = setup({}, { banLookup: async () => () => undefined });
      expect(await (await handleGuardRequest("banned", req("/", { headers: html }), none.deps)).text()).toContain("unavailable right now.");
      const lapsed = setup({}, ban(new Date(Date.now() - 1000)));
      expect(await (await handleGuardRequest("banned", req("/", { headers: html }), lapsed.deps)).text()).toContain("unavailable right now.");
    });

    it("shows an allowlisted address nothing about a ban", async () => {
      const { deps } = setup({}, { ...ban(in45()), allowed: async () => true });
      expect(await (await handleGuardRequest("banned", req("/", { headers: html }), deps)).text()).toContain("unavailable right now.");
    });

    it("leaves the plain-text answer for non-browsers alone", async () => {
      const { deps } = setup({}, ban(in45()));
      expect(await (await handleGuardRequest("banned", req("/"), deps)).text()).toBe("Forbidden\n");
    });
  });

  it("bans at the threshold and not before", async () => {
    const { deps, bans } = setup({ threshold: 3 });
    for (let i = 0; i < 2; i++) await handleGuardRequest("probe", req("/.git/config"), deps);
    expect(bans).toHaveLength(0);
    await handleGuardRequest("probe", req("/.git/config"), deps);
    expect(bans).toEqual([{ ip: IP, reason: "threshold", appId: null, hits: 3 }]);
  });

  it("answers a client that doesn't ask for a page with the status name as text", async () => {
    const { deps } = setup();
    expect(await (await handleGuardRequest("probe", req("/.env"), deps)).text()).toBe("Not Found\n");
    expect(await (await handleGuardRequest("probe", req("/HNAP1"), deps)).text()).toBe("Forbidden\n");
  });

  it("bans on the first trap hit and records only the address and path", async () => {
    const { deps, bans, events } = setup();
    const res = await handleGuardRequest("trap", req("/private/db.sql", { app: "app1" }), deps);
    expect(res.status).toBe(404);
    expect(bans).toEqual([{ ip: IP, reason: "trap", appId: "app1", hits: 1 }]);
    expect(events).toEqual([{ kind: "trap", ip: IP, path: "/private/db.sql", appId: "app1" }]);
  });

  it("serves the decoy at the decoy path and records the marker", async () => {
    const { deps, events } = setup();
    const res = await handleGuardRequest("trap", req("/admin-backup/.env", { app: "app1" }), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("AKIA_ABCDEFGHJK23_EXAMPLE");
    expect(events.map((e) => e.kind)).toEqual(["trap", "canary_fetch"]);
    expect(events[1].canaryId).toBe("c1");
  });

  it("bans a client that uses a canary and keeps nothing it sent", async () => {
    const { deps, bans, events } = setup();
    const values = canaryValues("abcdefghjk23");
    const basic = `Basic ${Buffer.from(`${values.ADMIN_USER}:whatever`).toString("base64")}`;
    const res = await handleGuardRequest("canary", req("/login", { headers: { authorization: basic } }), deps);
    expect(res.status).toBe(403);
    expect(deps.markUsed).toHaveBeenCalledWith("c1");
    expect(bans).toEqual([{ ip: IP, reason: "canary", appId: "app1", hits: 1 }]);
    expect(JSON.stringify(events)).not.toContain("whatever");
    expect(JSON.stringify(events)).not.toContain(basic);
  });

  it("finds canaries in query values", async () => {
    const { deps, bans } = setup();
    await handleGuardRequest("canary", req("/api", { query: `?api_key=${canaryValues("abcdefghjk23").SECRET_KEY}` }), deps);
    expect(bans).toHaveLength(1);
  });

  it("serves robots.txt with trap lines", async () => {
    const { deps } = setup();
    const res = await handleGuardRequest("robots", req("/robots.txt"), deps);
    const body = await res.text();
    expect(body).toContain("Disallow: /admin-backup/");
    expect(body).toContain("Allow: /");
  });

  it("answers banned clients without counting", async () => {
    const { deps, hits, bans } = setup();
    const res = await handleGuardRequest("banned", req("/anything"), deps);
    expect(res.status).toBe(403);
    expect(hits.size).toBe(0);
    expect(bans).toHaveLength(0);
  });

  it("answers a bare Forbidden when something fails", async () => {
    const { deps } = setup({}, { clientIp: async () => { throw new Error("boom"); } });
    const res = await handleGuardRequest("probe", req("/.env"), deps);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden\n");
  });

  it("sends no body for HEAD", async () => {
    const { deps } = setup();
    const res = await handleGuardRequest("probe", req("/.env", { method: "HEAD" }), deps);
    expect(await res.text()).toBe("");
  });
});

describe("helpers", () => {
  it("reads the original path without its query", () => {
    expect(originalPath(new Headers({ "x-replaced-path": "/.env?x=1" }))).toBe("/.env");
    expect(originalPath(new Headers())).toBe("/");
  });

  it("ignores query keys it doesn't watch", () => {
    const url = new URL("http://x/?comment=abcdefghjk23");
    expect(carriedMarker(new Headers(), url, ["abcdefghjk23"])).toBeNull();
  });
});

describe("probe events", () => {
  it("records each probe hit with its path, up to the per-window cap", async () => {
    const { deps, events } = setup({ threshold: 1000 });
    for (let i = 0; i < PROBE_EVENTS_PER_WINDOW + 10; i++) await handleGuardRequest("probe", req("/.env", { app: "app1" }), deps);
    const probes = events.filter((e) => e.kind === "probe");
    expect(probes).toHaveLength(PROBE_EVENTS_PER_WINDOW);
    expect(probes[0]).toEqual({ kind: "probe", ip: IP, path: "/.env", appId: "app1" });
  });

  it("records nothing when the hit counter fails", async () => {
    const { deps, events } = setup({}, { recordHit: async () => { throw new Error("redis down"); } });
    await handleGuardRequest("probe", req("/.env"), deps);
    expect(events).toHaveLength(0);
  });

  it("still answers when recording fails", async () => {
    const { deps } = setup({}, { recordEvent: async () => { throw new Error("db down"); } });
    expect((await handleGuardRequest("probe", req("/.env"), deps)).status).toBe(404);
  });

  it("caps at the window count", () => {
    expect(recordsProbeEvent(0)).toBe(false);
    expect(recordsProbeEvent(1)).toBe(true);
    expect(recordsProbeEvent(PROBE_EVENTS_PER_WINDOW)).toBe(true);
    expect(recordsProbeEvent(PROBE_EVENTS_PER_WINDOW + 1)).toBe(false);
  });
});
