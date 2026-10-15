import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { getSystemSettingRawMock } = vi.hoisted(() => ({ getSystemSettingRawMock: vi.fn() }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: getSystemSettingRawMock }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

import { collectorMode, collectorToken, shouldProvisionCollector, DEFAULT_COLLECTOR_IMAGE, PROVISIONED_COLLECTOR_URL } from "@/lib/collector/config";
import { metricsProvider, NO_CONTAINER_METRICS } from "@/lib/metrics/config";
import { CollectorMetricsProvider } from "@/lib/metrics/collector-provider";

describe("collectorMode — precedence", () => {
  it("provisions the published image with neither variable", () => {
    expect(collectorMode({})).toEqual({ kind: "provisioned", image: DEFAULT_COLLECTOR_IMAGE, url: PROVISIONED_COLLECTOR_URL });
    expect(shouldProvisionCollector({})).toBe(true);
  });

  it("is off when the image is set to off, in any case", () => {
    for (const value of ["off", "OFF", " Off "]) {
      expect(collectorMode({ VARDO_COLLECTOR_IMAGE: value })).toEqual({ kind: "off" });
      expect(shouldProvisionCollector({ VARDO_COLLECTOR_IMAGE: value })).toBe(false);
    }
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
    expect(collectorMode({ VARDO_COLLECTOR_URL: " ", VARDO_COLLECTOR_IMAGE: "" })).toEqual({
      kind: "provisioned",
      image: DEFAULT_COLLECTOR_IMAGE,
      url: PROVISIONED_COLLECTOR_URL,
    });
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

describe("metricsProvider", () => {
  it("reads no container metrics when the collector is off", async () => {
    const p = metricsProvider({ VARDO_COLLECTOR_IMAGE: "off" });
    expect(p).toBe(NO_CONTAINER_METRICS);
    await expect(p.fetchAll()).resolves.toEqual([]);
  });

  it("reads the collector alone in either mode", () => {
    expect(metricsProvider({ VARDO_COLLECTOR_IMAGE: "collector:3d51106" })).toBeInstanceOf(CollectorMetricsProvider);
    const p = metricsProvider({ VARDO_COLLECTOR_URL: "http://lab:9273", VARDO_COLLECTOR_IMAGE: "collector:x" });
    expect(p.name).toBe("collector at http://lab:9273");
  });
});
