import { describe, it, expect, vi, beforeEach } from "vitest";

const { settings } = vi.hoisted(() => ({
  settings: { allowlist: null as string | null, baseDomain: "" },
}));
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async () => settings.allowlist,
  getInstanceConfig: async () => ({ baseDomain: settings.baseDomain }),
}));

const { getDomainProbePolicy, getOutboundPolicy } = await import("@/lib/security/outbound-policy");

beforeEach(() => {
  delete process.env.VARDO_OUTBOUND_ALLOWLIST;
  delete process.env.VARDO_BASE_DOMAIN;
  settings.allowlist = null;
  settings.baseDomain = "";
});

describe("getDomainProbePolicy", () => {
  it("adds the base domain as a suffix entry", async () => {
    settings.allowlist = "hooks.internal";
    settings.baseDomain = "apps.example.com";
    expect(await getDomainProbePolicy()).toEqual({ allowlist: ["hooks.internal", ".apps.example.com"] });
  });

  it("leaves the general outbound policy without it", async () => {
    settings.baseDomain = "apps.example.com";
    expect(await getOutboundPolicy()).toEqual({ allowlist: [] });
  });

  it("adds nothing when no base domain is set", async () => {
    expect(await getDomainProbePolicy()).toEqual({ allowlist: [] });
  });
});
