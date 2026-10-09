import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { getDefaultCertResolver, type SslConfig } from "@/lib/system-settings";

const config = (activeIssuers: SslConfig["activeIssuers"]): SslConfig => ({
  activeIssuers,
  concurrentIssuers: 1,
  challengeType: "http",
});

describe("getDefaultCertResolver", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the HTTP challenge without Cloudflare credentials", () => {
    vi.stubEnv("CF_DNS_API_TOKEN", "");
    expect(getDefaultCertResolver(config(["le"]))).toBe("le");
    expect(getDefaultCertResolver(config(["google", "le"]))).toBe("google");
  });

  it("uses DNS-01 for the primary issuer with Cloudflare credentials", () => {
    vi.stubEnv("CF_DNS_API_TOKEN", "token");
    expect(getDefaultCertResolver(config(["le"]))).toBe("le-dns");
    expect(getDefaultCertResolver(config(["zerossl"]))).toBe("zerossl-dns");
    expect(getDefaultCertResolver(config([]))).toBe("le-dns");
  });

  it("ignores a blank token", () => {
    vi.stubEnv("CF_DNS_API_TOKEN", "  ");
    expect(getDefaultCertResolver(config(["le"]))).toBe("le");
  });
});
