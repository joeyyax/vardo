import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const { proxyConfig, proxyCreateBody, METADATA_ROUTE } = await import("@/lib/metadata/proxy");

describe("proxyConfig", () => {
  const conf = proxyConfig("vardo-console:3000");

  it("serves only /v1/self and 404s everything else", () => {
    expect(conf).toContain("location = /v1/self {");
    expect(conf).toMatch(/location \/ \{ return 404; \}/);
    expect(conf).toContain(`proxy_pass $console${METADATA_ROUTE};`);
  });

  it("limits each caller address", () => {
    expect(conf).toContain("limit_req_zone $binary_remote_addr zone=caller");
    expect(conf).toContain("limit_req zone=caller");
  });

  it("sets the caller headers from the connection and drops the app's forwarding and credentials", () => {
    expect(conf).toContain("proxy_set_header x-vardo-caller $remote_addr;");
    expect(conf).toContain("proxy_set_header x-vardo-local $server_addr;");
    expect(conf).toContain("proxy_set_header x-vardo-request $request;");
    for (const h of ["X-Forwarded-For", "Forwarded", "X-Real-IP", "Cookie", "Authorization"]) {
      expect(conf).toContain(`proxy_set_header ${h} "";`);
    }
  });

  it("refuses an upstream that could inject config", () => {
    expect(() => proxyConfig("evil; }")).toThrow();
    expect(() => proxyConfig("host:80/x")).toThrow();
  });
});

describe("proxyCreateBody", () => {
  it("runs unprivileged and read-only, and the hash follows the config", () => {
    const a = proxyCreateBody(proxyConfig("vardo-console:3000"), "nginx:1.31.6-alpine", false);
    const b = proxyCreateBody(proxyConfig("vardo-console:3001"), "nginx:1.31.6-alpine", false);
    expect(a.body.HostConfig).toMatchObject({ CapDrop: ["ALL"], ReadonlyRootfs: true, NetworkMode: "vardo-metadata" });
    expect(a.body.HostConfig.Sysctls).toEqual({ "net.ipv4.ip_forward": "0" });
    expect(a.body.Labels["vardo.managed"]).toBeUndefined();
    expect(a.hash).not.toBe(b.hash);
    expect(a.body.HostConfig).not.toHaveProperty("ExtraHosts");
    expect(proxyCreateBody(proxyConfig("host.docker.internal:3015"), "nginx:1.31.6-alpine", true).body.HostConfig.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
  });
});
