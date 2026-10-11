// The Traefik file that serves a public cron status page at its own host.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ admin: true, role: "owner" }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/system-settings", () => ({
  getSslConfig: async () => ({}),
  getDefaultCertResolver: () => "le",
  getInstanceConfig: async () => ({ domain: "vardo.example.com" }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => h.admin }));
vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({
    organization: { id: "org-1" },
    membership: { role: h.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/cron/status-route", async (orig) => ({
  ...(await orig<typeof import("@/lib/cron/status-route")>()),
  syncStatusRoutes: vi.fn().mockResolvedValue("written"),
}));

const real = await vi.importActual<typeof import("@/lib/cron/status-route")>("@/lib/cron/status-route");
const { statusRouteConfig, STATUS_ROUTE_FILE } = real;
const settings = await import("@/app/api/v1/organizations/[orgId]/cron/status-page/route");

const TOKEN = "tok_abcdefghijklmnopqrstu";
type Routers = Record<string, { rule: string; middlewares?: string[]; service: string }>;
type Middlewares = Record<string, { replacePath?: { path: string } }>;

describe("statusRouteConfig", () => {
  const config = statusRouteConfig([{ hostname: "Cron.Example.com", token: TOKEN }], "le") as {
    http: { routers: Routers; middlewares: Middlewares };
  };
  const { routers, middlewares } = config.http;
  const pathFor = (router: string) => middlewares[routers[router].middlewares![0]].replacePath?.path;

  it("rewrites / to the page and /status.json to the JSON", () => {
    expect(pathFor("vardo-cron-status-cron-example-com-page")).toBe(`/status/cron/${TOKEN}`);
    expect(pathFor("vardo-cron-status-cron-example-com-json")).toBe(`/api/status/cron/${TOKEN}`);
    expect(routers["vardo-cron-status-cron-example-com-page"].rule).toBe("Host(`cron.example.com`) && Path(`/`)");
  });

  it("sends every other path on the host to the 404 page", () => {
    expect(pathFor("vardo-cron-status-cron-example-com-other")).toBe("/unknown-host");
    expect(routers["vardo-cron-status-cron-example-com-assets"].middlewares).toBeUndefined();
  });

  it("skips a host or token that could break the rule", () => {
    expect(statusRouteConfig([{ hostname: "a.com`) || Host(`b.com", token: TOKEN }], "le")).toBeNull();
    expect(statusRouteConfig([{ hostname: "cron.example.com", token: "short" }], "le")).toBeNull();
  });
});

describe("syncStatusRoutes", () => {
  let dir: string;
  beforeEach(async () => {
    dbMock.reset();
    dir = await mkdtemp(join(tmpdir(), "cron-status-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes the file for enabled hosts and removes it when none are left", async () => {
    dbMock.query.cronStatusPages.findMany.mockResolvedValue([{ hostname: "cron.example.com", token: TOKEN }]);
    expect(await real.syncStatusRoutes(dir)).toBe("written");
    const parsed = YAML.parse(await readFile(join(dir, STATUS_ROUTE_FILE), "utf-8"));
    expect(Object.keys(parsed.http.routers)).toHaveLength(5);

    dbMock.query.cronStatusPages.findMany.mockResolvedValue([]);
    expect(await real.syncStatusRoutes(dir)).toBe("removed");
    await expect(stat(join(dir, STATUS_ROUTE_FILE))).rejects.toThrow();
  });
});

describe("PATCH status-page", () => {
  const patch = (body: Record<string, unknown>) =>
    settings.PATCH(
      jsonRequest("PATCH", "/api/v1/organizations/org-1/cron/status-page", { body }),
      routeCtx({ orgId: "org-1" }),
    );

  beforeEach(() => {
    dbMock.reset();
    h.admin = true;
    h.role = "owner";
    dbMock.insertReturns([{ organizationId: "org-1", enabled: true, token: TOKEN, hostname: null }]);
    dbMock.updateReturns([{ organizationId: "org-1", enabled: true, token: TOKEN, hostname: "cron.example.com" }]);
  });

  it("creates the page off unless asked, with a fresh token", async () => {
    dbMock.query.cronStatusPages.findFirst.mockResolvedValue(undefined);
    const res = await patch({ enabled: true });
    expect(res.status).toBe(200);
    const values = dbMock.inserts[0].values as { token: string; enabled: boolean };
    expect(values.enabled).toBe(true);
    expect(values.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("lets only an instance admin set the hostname", async () => {
    h.admin = false;
    dbMock.query.cronStatusPages.findFirst.mockResolvedValue({ organizationId: "org-1", enabled: true, token: TOKEN, hostname: null });
    expect((await patch({ hostname: "cron.example.com" })).status).toBe(403);
    expect(dbMock.updates).toHaveLength(0);
  });

  it("refuses a member", async () => {
    h.role = "member";
    expect((await patch({ enabled: true })).status).toBe(403);
  });

  it("refuses the console's own hostname", async () => {
    dbMock.query.cronStatusPages.findFirst.mockResolvedValue(undefined);
    expect((await patch({ hostname: "vardo.example.com" })).status).toBe(409);
  });
});
