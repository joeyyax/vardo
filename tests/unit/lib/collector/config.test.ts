import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { getSystemSettingRawMock } = vi.hoisted(() => ({ getSystemSettingRawMock: vi.fn() }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: getSystemSettingRawMock }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

import { collectorMode, collectorToken, shouldProvisionCollector, PROVISIONED_COLLECTOR_URL } from "@/lib/collector/config";
import { withCollector } from "@/lib/metrics/config";
import { FallbackMetricsProvider } from "@/lib/metrics/fallback-provider";
import type { MetricsProvider } from "@/lib/metrics/provider";

describe("collectorMode — precedence", () => {
  it("is off with neither variable, so cAdvisor behaves as before", () => {
    expect(collectorMode({})).toEqual({ kind: "off" });
    expect(shouldProvisionCollector({})).toBe(false);
  });

  it("provisions its own collector with only the image set", () => {
    expect(collectorMode({ VARDO_COLLECTOR_IMAGE: "collector:3d51106" })).toEqual({
      kind: "provisioned",
      image: "collector:3d51106",
      url: PROVISIONED_COLLECTOR_URL,
    });
    expect(shouldProvisionCollector({ VARDO_COLLECTOR_IMAGE: "collector:3d51106" })).toBe(true);
  });

  it("reads an existing collector when the URL is set, even with an image too", () => {
    const env = { VARDO_COLLECTOR_URL: "http://collector:9273/", VARDO_COLLECTOR_IMAGE: "collector:3d51106" };
    expect(collectorMode(env)).toEqual({ kind: "url", url: "http://collector:9273" });
    expect(shouldProvisionCollector(env)).toBe(false);
  });

  it("treats blank values as unset", () => {
    expect(collectorMode({ VARDO_COLLECTOR_URL: " ", VARDO_COLLECTOR_IMAGE: "" })).toEqual({ kind: "off" });
  });
});

describe("collectorToken", () => {
  beforeEach(() => getSystemSettingRawMock.mockReset());

  it("sends no token to an unauthenticated URL collector", async () => {
    expect(await collectorToken({ kind: "url", url: "http://c" }, {})).toBeNull();
  });

  it("takes the URL collector's token from the env, then a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collector-token-"));
    const file = join(dir, "token");
    writeFileSync(file, "from-file\n");
    const mode = { kind: "url", url: "http://c" } as const;
    expect(await collectorToken(mode, { VARDO_COLLECTOR_TOKEN: "from-env", VARDO_COLLECTOR_TOKEN_FILE: file })).toBe("from-env");
    expect(await collectorToken(mode, { VARDO_COLLECTOR_TOKEN_FILE: file })).toBe("from-file");
  });

  it("reads a provisioned collector's generated token from system settings", async () => {
    getSystemSettingRawMock.mockResolvedValue("generated");
    expect(await collectorToken({ kind: "provisioned", image: "x", url: PROVISIONED_COLLECTOR_URL }, {})).toBe("generated");
    expect(getSystemSettingRawMock).toHaveBeenCalledWith("collector_token");
  });
});

describe("withCollector", () => {
  const cadvisor: MetricsProvider = { name: "cAdvisor", fetchAll: async () => [] };

  it("keeps cAdvisor alone when no collector is configured", () => {
    expect(withCollector(cadvisor, {})).toBe(cadvisor);
  });

  it("puts the collector in front of cAdvisor in either mode", () => {
    for (const env of [{ VARDO_COLLECTOR_URL: "http://collector:9273" }, { VARDO_COLLECTOR_IMAGE: "collector:3d51106" }]) {
      const p = withCollector(cadvisor, env);
      expect(p).toBeInstanceOf(FallbackMetricsProvider);
      expect((p as FallbackMetricsProvider).fallback).toBe(cadvisor);
    }
    const p = withCollector(cadvisor, { VARDO_COLLECTOR_URL: "http://lab:9273", VARDO_COLLECTOR_IMAGE: "collector:x" }) as FallbackMetricsProvider;
    expect(p.primary.name).toBe("collector at http://lab:9273");
  });
});
