import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ settings: { visibility: "public", domain: "acme.example" }, admin: true }));

vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/auth/admin", () => ({
  requireAdminAuth: async () => {
    if (!h.admin) throw new Error("Unauthorized");
  },
}));
vi.mock("@/lib/trust/store", () => ({
  getTrustSettings: async () => ({ ...h.settings, name: null, hostingOverride: null, hostingDetected: null }),
  readResults: async () => [],
  effectiveHosting: () => null,
}));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "Acme", getInstanceConfig: async () => ({}) }));
vi.mock("@/lib/probe-guard/instance", () => ({ getProbeGuardSettings: async () => ({ securityContact: "security@acme.example" }) }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { GET } from "@/app/api/public/trust/route";
import { invalidatePublicTrust } from "@/lib/trust/public-load";

const get = (host: string, query = "") => GET(new NextRequest(`http://localhost/api/public/trust${query}`, { headers: { host } }));

beforeEach(() => {
  h.settings = { visibility: "public", domain: "acme.example" };
  h.admin = true;
  invalidatePublicTrust();
});

describe("GET /api/public/trust", () => {
  it("serves the page on the trust domain with security headers and a short cache", async () => {
    const res = await get("acme.example");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Trust center");
  });

  it("404s on every other host", async () => {
    expect((await get("other.example")).status).toBe(404);
    expect((await get("localhost:3000")).status).toBe(404);
  });

  it("404s while the page is private or off", async () => {
    for (const visibility of ["private", "off"]) {
      h.settings = { visibility, domain: "acme.example" };
      invalidatePublicTrust();
      expect((await get("acme.example")).status).toBe(404);
    }
  });

  it("serves a preview to admins on any host, uncached", async () => {
    h.settings = { visibility: "private", domain: "acme.example" };
    const res = await get("localhost:3000", "?preview=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a preview to anyone else", async () => {
    h.admin = false;
    expect((await get("acme.example", "?preview=1")).status).not.toBe(200);
  });
});
