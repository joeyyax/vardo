// Org build secrets: admin-only, write-only through the API and MCP, encrypted at rest.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dbMock } from "@/tests/helpers/db";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

const h = vi.hoisted(() => ({ role: "admin" }));
const VALUE = "ghp_classicPatWithReadPackages0123456789";

vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({ organization: { id: "org-1" }, membership: { role: h.role }, session: { user: { id: "u1" } } }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => false }));
vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: async () => false }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/rate-limit", () => ({ slidingWindowRateLimit: async () => ({ limited: false }) }));

const list = await import("@/app/api/v1/organizations/[orgId]/build-secrets/route");
const one = await import("@/app/api/v1/organizations/[orgId]/build-secrets/[name]/route");
const { registerBuildSecretTools } = await import("@/lib/mcp/tools/build-secrets");
const { decrypt } = await import("@/lib/crypto/encrypt");

const base = "http://localhost/api/v1/organizations/org-1/build-secrets";
const params = (name: string) => ({ params: Promise.resolve({ orgId: "org-1", name }) });
const put = (name: string, body: unknown) =>
  one.PUT(new NextRequest(`${base}/${name}`, { method: "PUT", body: JSON.stringify(body) }), params(name));

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const tools: Record<string, Handler> = {};
registerBuildSecretTools(
  { tool: (name: string, ...rest: unknown[]) => { tools[name] = rest.at(-1) as Handler; } } as unknown as McpServer,
  { userId: "u1", organizationId: "org-1" } as McpAuthContext,
);

const everything = () => JSON.stringify([recordActivity.mock.calls, dbMock.inserts.map((i) => (i.values as { name?: string }).name)]);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  h.role = "admin";
  dbMock.query.memberships.findFirst.mockImplementation(async () => ({ role: h.role, organization: { isSystemManaged: false } }));
  dbMock.query.orgBuildSecrets.findMany.mockResolvedValue([{ name: "npm_token", updatedAt: new Date("2026-11-01T00:00:00Z") }]);
  dbMock.deleteReturns([{ id: "s1" }]);
});

describe("REST", () => {
  it("refuses a member every route", async () => {
    h.role = "member";
    expect((await list.GET(new NextRequest(base), { params: Promise.resolve({ orgId: "org-1" }) })).status).toBe(403);
    expect((await put("npm_token", { value: VALUE })).status).toBe(403);
    expect((await one.DELETE(new NextRequest(`${base}/npm_token`, { method: "DELETE" }), params("npm_token"))).status).toBe(403);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("stores the value encrypted and answers with the name only", async () => {
    const res = await put("npm_token", { value: VALUE });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("npm_token");
    expect(body).not.toContain(VALUE);
    const row = dbMock.inserts[0].values as { name: string; value: string };
    expect(row.value).not.toContain(VALUE);
    expect(decrypt(row.value, "org-1")).toBe(VALUE);
  });

  it("audits the name and who set it, never the value", async () => {
    await put("npm_token", { value: VALUE });
    expect(recordActivity).toHaveBeenCalledWith({ organizationId: "org-1", action: "build_secret.set", userId: "u1", metadata: { name: "npm_token" } });
    expect(everything()).not.toContain(VALUE);
  });

  it("lists names without values", async () => {
    const res = await list.GET(new NextRequest(base), { params: Promise.resolve({ orgId: "org-1" }) });
    const body = await res.json();
    expect(body.buildSecrets).toEqual([{ name: "npm_token", updatedAt: "2026-11-01T00:00:00.000Z" }]);
  });

  it("rejects a name that isn't a safe secret id", async () => {
    for (const name of ["NPM_TOKEN", "npm-token", "1npm", "a,b"]) {
      expect((await put(name, { value: VALUE })).status).toBe(400);
    }
    expect((await put("npm_token", { value: "" })).status).toBe(400);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("deletes, and says when there was nothing to delete", async () => {
    const del = () => one.DELETE(new NextRequest(`${base}/npm_token`, { method: "DELETE" }), params("npm_token"));
    expect((await del()).status).toBe(200);
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "build_secret.deleted", metadata: { name: "npm_token" } }));
    dbMock.deleteReturns([]);
    expect((await del()).status).toBe(404);
  });
});

describe("MCP", () => {
  it("lists names only", async () => {
    const out = JSON.parse((await tools.vardo_list_build_secrets({})).content[0].text);
    expect(out).toEqual({ buildSecrets: [{ name: "npm_token", updatedAt: "2026-11-01T00:00:00.000Z" }] });
  });

  it("sets a secret without echoing it, recording MCP as the trigger", async () => {
    const result = await tools.vardo_set_build_secret({ name: "npm_token", value: VALUE });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain(VALUE);
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "build_secret.set", metadata: { name: "npm_token", trigger: "mcp" } }));
  });

  it("deletes when the value is left out", async () => {
    expect(JSON.parse((await tools.vardo_set_build_secret({ name: "npm_token" })).content[0].text)).toEqual({ deleted: "npm_token" });
  });

  it("refuses a member", async () => {
    h.role = "member";
    expect((await tools.vardo_set_build_secret({ name: "npm_token", value: VALUE })).isError).toBe(true);
    expect((await tools.vardo_list_build_secrets({})).isError).toBe(true);
    expect(dbMock.inserts).toHaveLength(0);
  });
});
