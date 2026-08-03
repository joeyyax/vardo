// ---------------------------------------------------------------------------
// Deploy-time DSN injection: which services get one, which are left alone, and
// what happens when GlitchTip is off, down or broken.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { featureEnabled, available, ensureProjectDSN } = vi.hoisted(() => ({
  featureEnabled: vi.fn().mockResolvedValue(true),
  available: vi.fn().mockResolvedValue(true),
  ensureProjectDSN: vi.fn(async (name: string): Promise<string | null> => `https://key@glitchtip/${name}`),
}));

vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: featureEnabled }));
vi.mock("@/lib/error-tracking/client", () => ({
  isGlitchTipAvailable: available,
  ensureProjectDSN,
}));

import { resolveServiceDSNs, clearDSNCache, hasOperatorDSN } from "@/lib/error-tracking/inject";

beforeEach(() => {
  clearDSNCache();
  vi.clearAllMocks();
  featureEnabled.mockResolvedValue(true);
  available.mockResolvedValue(true);
  ensureProjectDSN.mockImplementation(async (name: string) => `https://key@glitchtip/${name}`);
});

describe("resolveServiceDSNs", () => {
  it("resolves the parent app's project for every service without a child row", async () => {
    const result = await resolveServiceDSNs({
      appName: "blog",
      services: { web: {}, worker: {} },
    });

    expect(result).toEqual({
      web: "https://key@glitchtip/blog",
      worker: "https://key@glitchtip/blog",
    });
    expect(ensureProjectDSN).toHaveBeenCalledTimes(1);
    expect(ensureProjectDSN).toHaveBeenCalledWith("blog");
  });

  it("gives each decomposed child its own project", async () => {
    const result = await resolveServiceDSNs({
      appName: "stack",
      services: { api: {}, worker: {} },
      serviceAppNames: { api: "stack-api", worker: "stack-worker" },
    });

    expect(result).toEqual({
      api: "https://key@glitchtip/stack-api",
      worker: "https://key@glitchtip/stack-worker",
    });
    expect(ensureProjectDSN.mock.calls.map((c) => c[0]).sort()).toEqual(["stack-api", "stack-worker"]);
  });

  it("never overwrites an operator-set DSN on the app", async () => {
    const result = await resolveServiceDSNs({
      appName: "blog",
      services: { web: {} },
      appEnv: { GLITCHTIP_DSN: "https://operator@sentry.io/9" },
    });

    expect(result).toEqual({});
    expect(ensureProjectDSN).not.toHaveBeenCalled();
  });

  it("never overwrites a SENTRY_DSN declared in the compose file", async () => {
    const result = await resolveServiceDSNs({
      appName: "stack",
      services: {
        api: { environment: { SENTRY_DSN: "https://operator@sentry.io/9" } },
        worker: {},
      },
      serviceAppNames: { api: "stack-api", worker: "stack-worker" },
    });

    expect(result).toEqual({ worker: "https://key@glitchtip/stack-worker" });
    expect(ensureProjectDSN).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a DSN set on a child app", async () => {
    const result = await resolveServiceDSNs({
      appName: "stack",
      services: { api: {}, worker: {} },
      serviceAppNames: { api: "stack-api", worker: "stack-worker" },
      serviceEnv: { api: { GLITCHTIP_DSN: "https://operator@sentry.io/9" } },
    });

    expect(result).toEqual({ worker: "https://key@glitchtip/stack-worker" });
  });

  it("calls nothing when the feature flag is off", async () => {
    featureEnabled.mockResolvedValue(false);

    const result = await resolveServiceDSNs({ appName: "blog", services: { web: {} } });

    expect(result).toEqual({});
    expect(available).not.toHaveBeenCalled();
    expect(ensureProjectDSN).not.toHaveBeenCalled();
  });

  it("returns nothing when GlitchTip is unreachable", async () => {
    available.mockResolvedValue(false);

    const result = await resolveServiceDSNs({ appName: "blog", services: { web: {} } });

    expect(result).toEqual({});
    expect(ensureProjectDSN).not.toHaveBeenCalled();
  });

  it("swallows a GlitchTip API failure", async () => {
    ensureProjectDSN.mockRejectedValue(new Error("GlitchTip API 500: boom"));

    await expect(resolveServiceDSNs({ appName: "blog", services: { web: {} } })).resolves.toEqual({});
  });

  it("swallows an availability check that throws", async () => {
    available.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(resolveServiceDSNs({ appName: "blog", services: { web: {} } })).resolves.toEqual({});
  });

  it("reuses a resolved DSN instead of calling GlitchTip on every deploy", async () => {
    await resolveServiceDSNs({ appName: "blog", services: { web: {} } });
    const second = await resolveServiceDSNs({ appName: "blog", services: { web: {}, worker: {} } });

    expect(second.worker).toBe("https://key@glitchtip/blog");
    expect(ensureProjectDSN).toHaveBeenCalledTimes(1);
  });

  it("does not cache a project that failed to resolve", async () => {
    ensureProjectDSN.mockResolvedValueOnce(null);
    await resolveServiceDSNs({ appName: "blog", services: { web: {} } });

    const second = await resolveServiceDSNs({ appName: "blog", services: { web: {} } });

    expect(second).toEqual({ web: "https://key@glitchtip/blog" });
    expect(ensureProjectDSN).toHaveBeenCalledTimes(2);
  });
});

describe("hasOperatorDSN", () => {
  it("matches either DSN key and ignores empty maps", () => {
    expect(hasOperatorDSN({ GLITCHTIP_DSN: "x" })).toBe(true);
    expect(hasOperatorDSN(undefined, { SENTRY_DSN: "x" })).toBe(true);
    expect(hasOperatorDSN({}, undefined, { PORT: "3000" })).toBe(false);
  });
});
