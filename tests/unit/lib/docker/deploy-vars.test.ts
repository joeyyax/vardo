import { describe, it, expect } from "vitest";
import { buildVars, deployVars, domainUrl, memoryBytes, serviceUrls, withoutOwn } from "@/lib/docker/deploy-vars";

const SHA = "a".repeat(40);

describe("buildVars", () => {
  it("gives only the commit and branch", () => {
    expect(buildVars(SHA, "main")).toEqual({ VARDO_GIT_SHA: SHA, VARDO_GIT_BRANCH: "main" });
  });

  it("gives nothing without a commit", () => {
    expect(buildVars(undefined, "main")).toEqual({});
    expect(buildVars("not-a-sha", "main")).toEqual({});
  });

  it("leaves out a key the app's env sets", () => {
    expect(buildVars(SHA, "main", { VARDO_GIT_SHA: "mine" })).toEqual({ VARDO_GIT_BRANCH: "main" });
  });
});

describe("deployVars", () => {
  const meta = { gitSha: SHA, gitBranch: "main", deploymentId: "dep-1", deployedAt: new Date("2026-10-17T12:00:00Z"), environment: "production", slot: "green" };

  it("sets every key it has a value for", () => {
    expect(deployVars(meta, { appName: "blog", url: "https://blog.example.com", memoryBytes: 536870912 })).toEqual({
      VARDO_GIT_SHA: SHA,
      VARDO_GIT_BRANCH: "main",
      VARDO_DEPLOY_ID: "dep-1",
      VARDO_DEPLOYED_AT: "2026-10-17T12:00:00.000Z",
      VARDO_APP_NAME: "blog",
      VARDO_APP_URL: "https://blog.example.com",
      VARDO_ENVIRONMENT: "production",
      VARDO_MEMORY_LIMIT: "536870912",
      VARDO_SLOT: "green",
    });
  });

  it("leaves out what doesn't apply: no repo, domain, limit or slot", () => {
    const vars = deployVars({ ...meta, gitSha: null, slot: null }, { appName: "redis", url: null, memoryBytes: null });
    expect(Object.keys(vars).sort()).toEqual(["VARDO_APP_NAME", "VARDO_DEPLOYED_AT", "VARDO_DEPLOY_ID", "VARDO_ENVIRONMENT"]);
  });
});

describe("memoryBytes", () => {
  it("reads compose sizes", () => {
    expect(memoryBytes("512M")).toBe(512 * 1024 ** 2);
    expect(memoryBytes("1g")).toBe(1024 ** 3);
    expect(memoryBytes("1.5gb")).toBe(1.5 * 1024 ** 3);
    expect(memoryBytes("64k")).toBe(65536);
    expect(memoryBytes("1048576")).toBe(1048576);
    expect(memoryBytes(2048)).toBe(2048);
  });

  it("is null for none or what it can't read", () => {
    expect(memoryBytes(undefined)).toBeNull();
    expect(memoryBytes("${MEM:-1g}")).toBeNull();
    expect(memoryBytes("0")).toBeNull();
  });
});

describe("serviceUrls", () => {
  const parent = { appId: "app", domain: "shop.example.com", isPrimary: true };

  it("gives a child service its own primary domain and the rest the app's", () => {
    const domains = [
      { appId: "app", domain: "old.example.com" },
      parent,
      { appId: "child-api", domain: "api.example.com", serviceName: "api", isPrimary: true },
    ];
    expect(serviceUrls(domains, "app", ["web", "api", "worker"], new Set(["api", "worker"]))).toEqual({
      web: "https://shop.example.com",
      api: "https://api.example.com",
      worker: "https://shop.example.com",
    });
  });

  it("skips redirects and disabled domains", () => {
    const domains = [
      { appId: "app", domain: "www.example.com", isPrimary: true, redirectTo: "https://example.com" },
      { appId: "app", domain: "off.example.com", enabled: false },
      { appId: "app", domain: "example.com" },
    ];
    expect(serviceUrls(domains, "app", ["web"], new Set())).toEqual({ web: "https://example.com" });
  });

  it("falls back to a child's domain when the app has none, and to null with no domain at all", () => {
    const child = { appId: "child-web", domain: "web.example.com", serviceName: "web" };
    expect(serviceUrls([child], "app", ["worker"], new Set(["worker"]))).toEqual({ worker: "https://web.example.com" });
    expect(serviceUrls([], "app", ["web"], new Set())).toEqual({ web: null });
  });
});

describe("domainUrl", () => {
  it("uses http without TLS and keeps the path prefix", () => {
    expect(domainUrl({ domain: "a.test", sslEnabled: false, pathPrefix: "/docs/" })).toBe("http://a.test/docs");
  });
});

describe("withoutOwn", () => {
  it("drops keys any source sets", () => {
    expect(withoutOwn({ A: "1", B: "2", C: "3" }, { A: "x" }, undefined, { C: "" })).toEqual({ B: "2" });
  });
});
