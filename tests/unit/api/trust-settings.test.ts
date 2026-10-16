import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ before: { visibility: "private", domain: "acme.example", name: null as string | null }, updated: null as unknown }));

vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/auth/admin", () => ({ requireAdminAuth: async () => {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ error: () => {} }) } }));
vi.mock("@/lib/trust/domains", () => ({ listTrustDomains: async () => ["acme.example"] }));
vi.mock("@/lib/trust/run", () => ({ runChecks: async () => {} }));
vi.mock("@/lib/trust/route", () => ({ syncTrustRoutes: async () => "unchanged" }));
vi.mock("@/lib/trust/public-load", () => ({ invalidatePublicTrust: () => {} }));
vi.mock("@/lib/trust/view", () => ({ buildTrustView: async () => ({ ok: true }) }));
vi.mock("@/lib/trust/store", () => ({
  getTrustSettings: async () => h.before,
  clearResults: async () => {},
  updateTrustSettings: async (patch: Record<string, unknown>) => {
    h.updated = patch;
    return { ...h.before, ...patch };
  },
}));

import { PATCH } from "@/app/api/v1/admin/trust/route";

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/v1/admin/trust", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  h.before = { visibility: "private", domain: "acme.example", name: null };
  h.updated = null;
});

describe("PATCH /api/v1/admin/trust", () => {
  it("won't make the page public without a name", async () => {
    const res = await patch({ visibility: "public" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("name");
    expect(h.updated).toBeNull();
  });

  it("makes it public once a name is set, in the same request or before", async () => {
    expect((await patch({ visibility: "public", name: "Joey Yax" })).status).toBe(200);
    h.before = { visibility: "private", domain: "acme.example", name: "Joey Yax" };
    expect((await patch({ visibility: "public" })).status).toBe(200);
  });

  it("won't clear the name while the page is public", async () => {
    h.before = { visibility: "public", domain: "acme.example", name: "Joey Yax" };
    expect((await patch({ name: "" })).status).toBe(400);
  });

  it("won't go public without a domain, or on a domain that isn't the instance's", async () => {
    h.before = { visibility: "private", domain: null as unknown as string, name: "Joey Yax" };
    expect((await patch({ visibility: "public" })).status).toBe(400);
    expect((await patch({ visibility: "public", domain: "elsewhere.example" })).status).toBe(400);
  });
});
