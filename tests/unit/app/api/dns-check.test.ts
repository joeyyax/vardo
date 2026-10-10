import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { resolve4, resolveCname, probeReach, getConfig } = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolveCname: vi.fn(),
  probeReach: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("dns/promises", () => ({ resolve4, resolveCname }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/auth/admin", () => ({ requireAdminAuth: async () => ({}) }));
vi.mock("@/lib/server-ip", () => ({ getServerIP: async () => "192.0.2.10" }));
vi.mock("@/lib/domain-monitoring/base-domain", () => ({ getInstanceBaseDomain: async () => "example.com" }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: getConfig }));
vi.mock("@/lib/domains/reach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/domains/reach")>()),
  probeReach,
}));

import { GET } from "@/app/api/v1/dns-check/route";
import { GET as ADMIN_GET } from "@/app/api/v1/admin/dns-check/route";

type Handler = (r: NextRequest) => Promise<Response>;

async function check(domain: string) {
  const res = await (GET as unknown as Handler)(new NextRequest(`http://localhost/api/v1/dns-check?domain=${domain}`));
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  resolve4.mockRejectedValue(new Error("ENODATA"));
  resolveCname.mockRejectedValue(new Error("ENODATA"));
  getConfig.mockResolvedValue({ serverIp: "192.0.2.10", baseDomain: "example.com", domain: "vardo.example.com" });
});

describe("GET /api/v1/dns-check", () => {
  it("connects on a verified token, whatever the A record", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockResolvedValue({ outcome: "verified", proxy: "proxy" });
    const body = await check("app.example.net");
    expect(body).toMatchObject({ status: "configured", configured: true, verified: true, proxied: true, proxyProvider: "proxy" });
    expect(body.records.a).toEqual(["198.51.100.7"]);
  });

  it("fails a domain that reaches another server, even through Cloudflare", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockResolvedValue({ outcome: "other-server", proxy: "cloudflare" });
    expect(await check("app.example.net")).toMatchObject({ status: "wrong-target", configured: false, reachable: true, proxyProvider: "cloudflare" });
  });

  it("trusts records pointing here when nothing answered to ask", async () => {
    resolve4.mockResolvedValue(["192.0.2.10"]);
    probeReach.mockResolvedValue({ outcome: "no-response", proxy: null });
    expect(await check("app.example.net")).toMatchObject({ status: "configured", configured: true, verified: false });
  });

  it("accepts a CNAME to the base domain on the same fallback", async () => {
    resolveCname.mockResolvedValue(["edge.example.com"]);
    probeReach.mockResolvedValue({ outcome: "blocked", proxy: null });
    expect(await check("app.example.net")).toMatchObject({ configured: true, verified: false });
  });

  it("reports silence with records elsewhere as not responding", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockResolvedValue({ outcome: "no-response", proxy: null });
    expect(await check("app.example.net")).toMatchObject({ status: "not-responding", configured: false, reachable: false });
  });

  it("skips the probe without records", async () => {
    expect(await check("app.example.net")).toMatchObject({ status: "no-records", configured: false });
    expect(probeReach).not.toHaveBeenCalled();
  });

  it("reports a failed probe as a failed check", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockRejectedValue(new Error("redis down"));
    expect((await check("app.example.net")).status).toBe("error");
  });

  it("refuses anything but a hostname", async () => {
    const res = await (GET as unknown as Handler)(new NextRequest("http://localhost/api/v1/dns-check?domain=203.0.113.5:8080/x"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/admin/dns-check", () => {
  it("checks the console and base domains by token", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockResolvedValueOnce({ outcome: "verified", proxy: "cloudflare" }).mockResolvedValueOnce({ outcome: "other-server", proxy: null });
    const res = await (ADMIN_GET as unknown as Handler)(new NextRequest("http://localhost/api/v1/admin/dns-check"));
    const { checks } = await res.json();
    expect(checks).toEqual([
      expect.objectContaining({ domain: "vardo.example.com", matches: true, verified: true, proxyProvider: "cloudflare" }),
      expect.objectContaining({ domain: "example.com", matches: false, reachable: true }),
    ]);
  });

  it("keeps a failed probe apart from missing records", async () => {
    resolve4.mockResolvedValue(["198.51.100.7"]);
    probeReach.mockRejectedValue(new Error("redis down"));
    const res = await (ADMIN_GET as unknown as Handler)(new NextRequest("http://localhost/api/v1/admin/dns-check"));
    const { checks } = await res.json();
    expect(checks[0]).toMatchObject({ resolved: true, failed: true });
  });
});
