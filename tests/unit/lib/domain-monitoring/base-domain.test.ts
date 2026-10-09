// Base domain order for auto-domains (#896): org, then instance config, then VARDO_BASE_DOMAIN.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { config } = vi.hoisted(() => ({ config: { baseDomain: "" } }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => config }));

import {
  baseDomainMismatch,
  generateEnvironmentSubdomain,
  generatePreviewSubdomain,
  getBaseDomain,
  getInstanceBaseDomain,
  pickBaseDomain,
} from "@/lib/domain-monitoring/auto-domain";

beforeEach(() => {
  config.baseDomain = "";
  vi.unstubAllEnvs();
});

describe("pickBaseDomain", () => {
  it("prefers the org, then the instance, then the env var, then localhost", () => {
    expect(pickBaseDomain("org.com", "inst.com", "env.com")).toBe("org.com");
    expect(pickBaseDomain(null, "inst.com", "env.com")).toBe("inst.com");
    expect(pickBaseDomain("", "", "env.com")).toBe("env.com");
    expect(pickBaseDomain(null, null, undefined)).toBe("localhost");
  });

  it("keeps an org base domain of example.com whatever the instance and env say", () => {
    expect(pickBaseDomain("example.com", "other.example", "")).toBe("example.com");
    expect(pickBaseDomain("example.com", "", "other.example")).toBe("example.com");
  });
});

describe("getBaseDomain", () => {
  it("returns the org base domain without reading instance config", async () => {
    config.baseDomain = "inst.com";
    expect(await getBaseDomain("example.com")).toBe("example.com");
  });

  it("falls back to the instance base domain over VARDO_BASE_DOMAIN", async () => {
    vi.stubEnv("VARDO_BASE_DOMAIN", "env.com");
    config.baseDomain = "inst.com";
    expect(await getBaseDomain(null)).toBe("inst.com");
    expect(await getInstanceBaseDomain()).toBe("inst.com");
  });

  it("uses VARDO_BASE_DOMAIN when the instance has none", async () => {
    vi.stubEnv("VARDO_BASE_DOMAIN", "env.com");
    expect(await getBaseDomain(undefined)).toBe("env.com");
  });

  it("builds environment and preview hosts on the resolved base", async () => {
    config.baseDomain = "inst.com";
    const base = await getBaseDomain(null);
    expect(generateEnvironmentSubdomain("web", "Staging 2", base)).toBe("web-staging-2.inst.com");
    expect(generatePreviewSubdomain("web", 12, base)).toBe("web-pr-12.inst.com");
  });
});

describe("baseDomainMismatch", () => {
  it("warns when both are set and differ", () => {
    expect(baseDomainMismatch("inst.com", "env.com")).toMatch(/inst\.com.*env\.com/);
  });

  it("stays quiet when either is unset or they match ignoring case", () => {
    expect(baseDomainMismatch("", "env.com")).toBeNull();
    expect(baseDomainMismatch("inst.com", undefined)).toBeNull();
    expect(baseDomainMismatch("Inst.com", "inst.com")).toBeNull();
  });
});
