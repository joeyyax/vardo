// vardo_list/add/update/remove/set_primary_domain: what the MCP layer decides,
// with the shared domain rules in lib/domains/manage running for real.

process.env.ENCRYPTION_MASTER_KEY ??= "f".repeat(64);

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

const { canAccessOrg } = vi.hoisted(() => ({ canAccessOrg: vi.fn() }));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/mcp/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/scope")>()),
  canAccessOrg,
}));
vi.mock("@/lib/domains/context", () => ({
  proofForNewDomain: async (host: string) => ({
    verificationToken: "vardo-t",
    verifiedAt: host.endsWith("proven.com") ? new Date("2026-10-01") : null,
  }),
}));
vi.mock("@/lib/domains/claim", async () => {
  const { db } = await import("@/lib/db");
  return {
    hostHoldByOtherOrg: async (host: string) => (host === "taken.com" ? "taken" : "free"),
    withClaim: async (_claim: unknown, write: (exec: unknown) => Promise<unknown>) => write(db),
  };
});
vi.mock("@/lib/system-settings", () => ({
  getSslConfig: async () => ({}),
  getDefaultCertResolver: () => "le-dns",
  CERT_RESOLVERS: ["le", "le-dns", "google", "google-dns", "zerossl", "zerossl-dns"],
}));

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

async function tools(): Promise<Record<string, Handler>> {
  const { registerDomainTools } = await import("@/lib/mcp/tools/domains");
  const found: Record<string, Handler> = {};
  const server = { tool: (name: string, _d: string, _s: unknown, fn: Handler) => void (found[name] = fn) };
  registerDomainTools(server as never, { userId: "u1", organizationId: "o1", crossOrg: false } as never);
  return found;
}

const body = (r: Result) => JSON.parse(r.content[0].text);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "d1",
  appId: "a1",
  domain: "acme.com",
  pathPrefix: null,
  stripPathPrefix: false,
  serviceName: null,
  port: null,
  middlewares: null,
  certResolver: "le-dns",
  isPrimary: false,
  enabled: true,
  sslEnabled: true,
  redirectTo: null,
  redirectCode: 301,
  verificationToken: "vardo-t",
  verifiedAt: null,
  source: "vardo",
  composeRouter: null,
  createdAt: new Date("2026-10-01"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  canAccessOrg.mockResolvedValue(true);
  dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1", organizationId: "o1", isSystemManaged: false });
  dbMock.query.domains.findMany.mockResolvedValue([]);
});

describe("vardo_add_domain", () => {
  it("routes a host for the app and asks for a deploy", async () => {
    dbMock.insertReturns([row()]);
    const res = await (await tools()).vardo_add_domain({ appId: "a1", domain: "Acme.com", port: 3000 });
    expect(res.isError).toBeUndefined();
    expect(dbMock.inserts[0].values).toMatchObject({ appId: "a1", domain: "acme.com", port: 3000, certResolver: "le-dns" });
    expect(body(res).note).toMatch(/deploy/i);
  });

  it("marks the app for redeploy", async () => {
    dbMock.insertReturns([row()]);
    await (await tools()).vardo_add_domain({ appId: "a1", domain: "acme.com" });
    expect(dbMock.updates.map((u) => u.set)).toContainEqual({ needsRedeploy: true, updatedAt: expect.any(Date) });
  });

  it("flags a host whose ownership isn't proved yet", async () => {
    const t = await tools();
    dbMock.insertReturns([row()]);
    expect(body(await t.vardo_add_domain({ appId: "a1", domain: "acme.com" })).note).toMatch(/ownership/i);

    dbMock.insertReturns([row({ verifiedAt: new Date("2026-10-01") })]);
    expect(body(await t.vardo_add_domain({ appId: "a1", domain: "proved.com" })).note).not.toMatch(/ownership/i);
  });

  it("refuses a host another organization routes, and stores nothing", async () => {
    const res = await (await tools()).vardo_add_domain({ appId: "a1", domain: "taken.com" });
    expect(res.isError).toBe(true);
    expect(body(res).error).toMatch(/another organization/i);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("refuses a token that can't manage domains", async () => {
    canAccessOrg.mockResolvedValue(false);
    const res = await (await tools()).vardo_add_domain({ appId: "a1", domain: "acme.com" });
    expect(res.isError).toBe(true);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("refuses a redirect that points at the host itself", async () => {
    const res = await (await tools()).vardo_add_domain({
      appId: "a1",
      domain: "acme.com",
      redirectTo: "https://acme.com/pricing",
    });
    expect(res.isError).toBe(true);
    expect(dbMock.inserts).toHaveLength(0);
  });
});

describe("vardo_update_domain", () => {
  it("changes a Vardo-managed host", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row());
    dbMock.updateReturns([row({ domain: "acme.io" })]);
    const res = await (await tools()).vardo_update_domain({ appId: "a1", domainId: "d1", domain: "acme.io" });
    expect(res.isError).toBeUndefined();
    expect(dbMock.updates[0].set).toMatchObject({ domain: "acme.io", verificationToken: "vardo-t" });
  });

  it("refuses a host the app's compose file declares", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row({ source: "compose" }));
    const res = await (await tools()).vardo_update_domain({ appId: "a1", domainId: "d1", port: 8080 });
    expect(res.isError).toBe(true);
    expect(body(res).error).toMatch(/compose/i);
    expect(dbMock.updates).toHaveLength(0);
  });

  it("keeps the stored host when only its case differs", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row());
    dbMock.updateReturns([row()]);
    const res = await (await tools()).vardo_update_domain({ appId: "a1", domainId: "d1", domain: "ACME.COM" });
    expect(res.isError).toBeUndefined();
    expect(dbMock.updates[0].set).not.toHaveProperty("domain");
  });

  it("turns a domain off and drops its primary flag", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row({ isPrimary: true }));
    dbMock.updateReturns([row({ enabled: false })]);
    const res = await (await tools()).vardo_update_domain({ appId: "a1", domainId: "d1", enabled: false });
    expect(res.isError).toBeUndefined();
    expect(dbMock.updates[0].set).toEqual({ enabled: false, isPrimary: false });
  });
});

describe("vardo_remove_domain", () => {
  it("deletes the route and reports the deploy step", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row());
    dbMock.deleteReturns([{ id: "d1" }]);
    const res = await (await tools()).vardo_remove_domain({ appId: "a1", domainId: "d1" });
    expect(res.isError).toBeUndefined();
    expect(dbMock.deletes).toHaveLength(1);
    expect(body(res).note).toMatch(/deploy/i);
  });

  it("refuses a host the app's compose file declares", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row({ source: "compose" }));
    const res = await (await tools()).vardo_remove_domain({ appId: "a1", domainId: "d1" });
    expect(res.isError).toBe(true);
    expect(dbMock.deletes).toHaveLength(0);
  });
});

describe("vardo_set_primary_domain", () => {
  it("clears the old primary before setting the new one", async () => {
    dbMock.query.domains.findFirst.mockResolvedValue(row());
    dbMock.updateReturns([row({ isPrimary: true })]);
    const res = await (await tools()).vardo_set_primary_domain({ appId: "a1", domainId: "d1" });
    expect(res.isError).toBeUndefined();
    const sets = dbMock.updates.map((u) => u.set);
    expect(sets[0]).toEqual({ isPrimary: false });
    expect(sets[1]).toEqual({ isPrimary: true });
    expect(body(res).domain.isPrimary).toBe(true);
  });
});

describe("vardo_list_domains", () => {
  it("lists hosts without the verification token", async () => {
    dbMock.query.domains.findMany.mockResolvedValue([
      row(),
      row({ id: "d2", domain: "old.acme.com", source: "compose", middlewares: "cloudflare-only@file" }),
    ]);
    const res = await (await tools()).vardo_list_domains({ appId: "a1" });
    expect(res.content[0].text).not.toContain("vardo-t");
    const listed = body(res);
    expect(
      listed.domains.map((d: { middlewares: string[] }) => d.middlewares)
    ).toEqual([[], ["cloudflare-only@file"]]);
    expect(listed.readOnly).toEqual(["old.acme.com"]);
  });

  it("reads an app a view-only token can see", async () => {
    canAccessOrg.mockImplementation(async (_c: unknown, _o: unknown, cap: string) => cap === "app.view");
    dbMock.query.domains.findMany.mockResolvedValue([row()]);
    const res = await (await tools()).vardo_list_domains({ appId: "a1" });
    expect(res.isError).toBeUndefined();
    expect(body(res).domains).toHaveLength(1);
  });
});
