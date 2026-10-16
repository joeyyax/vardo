import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => ({}), getSslConfig: async () => ({}), getDefaultCertResolver: () => "le" }));

import { isTrustHost, requestHost } from "@/lib/trust/domains";
import { TRUST_DPA_TARGET, TRUST_PAGE_TARGET, trustRouteConfig } from "@/lib/trust/route";

describe("requestHost", () => {
  it("lowercases and drops the port", () => {
    expect(requestHost(new Headers({ host: "Trust.Acme.Example:443" }))).toBe("trust.acme.example");
    expect(requestHost(new Headers())).toBeNull();
  });
});

describe("isTrustHost", () => {
  it("matches only the chosen domain", () => {
    expect(isTrustHost("acme.example", "ACME.example")).toBe(true);
    expect(isTrustHost("other.example", "acme.example")).toBe(false);
    expect(isTrustHost("sub.acme.example", "acme.example")).toBe(false);
    expect(isTrustHost("acme.example", null)).toBe(false);
    expect(isTrustHost(null, "acme.example")).toBe(false);
  });
});

describe("trustRouteConfig", () => {
  const config = trustRouteConfig("acme.example", "le-dns") as { http: { routers: Record<string, Record<string, unknown>>; middlewares: Record<string, unknown> } };

  it("routes only /trust and /trust/dpa.pdf on the domain", () => {
    const rules = Object.values(config.http.routers).map((r) => r.rule);
    expect(rules).toEqual(["Host(`acme.example`) && Path(`/trust`)", "Host(`acme.example`) && Path(`/trust/dpa.pdf`)"]);
  });

  it("rewrites them to the public handlers with replacePath", () => {
    const targets = Object.values(config.http.middlewares).map((m) => (m as { replacePath: { path: string } }).replacePath.path);
    expect(targets).toEqual([TRUST_PAGE_TARGET, TRUST_DPA_TARGET]);
    for (const router of Object.values(config.http.routers)) {
      expect(router.service).toBe("vardo@docker");
      expect(router.priority).toBeGreaterThan(10_000);
    }
  });

  it("serializes to YAML Traefik can read", () => {
    expect(YAML.parse(YAML.stringify(config))).toEqual(config);
  });

  it("refuses a host that could inject rule syntax", () => {
    expect(trustRouteConfig("a.example`) || Host(`b", "le")).toBeNull();
    expect(trustRouteConfig("", "le")).toBeNull();
  });
});
