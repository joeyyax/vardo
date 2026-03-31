import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("dns", () => ({
  promises: {
    resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { checkSecurityHeaders } from "@/lib/security/headers";

function headersFrom(obj: Record<string, string>): Headers {
  return new Headers(obj);
}

function mockHeadResponse(headerObj: Record<string, string>): Response {
  return {
    headers: headersFrom(headerObj),
  } as unknown as Response;
}

beforeEach(() => {
  // Default: respond with all security headers present and valid
  mockFetch.mockResolvedValue(
    mockHeadResponse({
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "content-security-policy": "default-src 'self'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "geolocation=()",
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkSecurityHeaders", () => {
  it("returns no findings when all required headers are present", async () => {
    const findings = await checkSecurityHeaders("example.com");
    expect(findings).toEqual([]);
  });

  it("flags missing Strict-Transport-Security as critical", async () => {
    mockFetch.mockResolvedValue(mockHeadResponse({}));
    const findings = await checkSecurityHeaders("example.com");
    const hsts = findings.find((f) => f.detail === "strict-transport-security");
    expect(hsts).toBeDefined();
    expect(hsts?.severity).toBe("critical");
  });

  it("flags missing Content-Security-Policy as warning", async () => {
    mockFetch.mockResolvedValue(
      mockHeadResponse({
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=()",
      }),
    );
    const findings = await checkSecurityHeaders("example.com");
    const csp = findings.find((f) => f.detail === "content-security-policy");
    expect(csp).toBeDefined();
    expect(csp?.severity).toBe("warning");
  });

  it("flags misconfigured X-Content-Type-Options", async () => {
    mockFetch.mockResolvedValue(
      mockHeadResponse({
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'",
        "x-content-type-options": "wrong-value",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=()",
      }),
    );
    const findings = await checkSecurityHeaders("example.com");
    const xct = findings.find((f) => f.detail === "x-content-type-options");
    expect(xct).toBeDefined();
    expect(xct?.title).toMatch(/Misconfigured/);
  });

  it("accepts CSP frame-ancestors as substitute for X-Frame-Options", async () => {
    mockFetch.mockResolvedValue(
      mockHeadResponse({
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=()",
      }),
    );
    const findings = await checkSecurityHeaders("example.com");
    expect(findings.find((f) => f.detail === "x-frame-options")).toBeUndefined();
  });

  it("returns no findings on network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const findings = await checkSecurityHeaders("example.com");
    expect(findings).toEqual([]);
  });
});
