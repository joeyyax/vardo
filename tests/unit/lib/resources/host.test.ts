import { describe, it, expect, vi, beforeEach } from "vitest";

const getSystemInfo = vi.fn();
vi.mock("@/lib/docker/client", () => ({ getSystemInfo }));
const stored = vi.hoisted(() => ({ raw: null as string | null, fail: false }));
const setSystemSetting = vi.fn(async (_key: string, value: string) => {
  stored.raw = value;
});
vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: async () => {
    if (stored.fail) throw new Error("db down");
    return stored.raw;
  },
  invalidateSettingsCache: () => {},
  setSystemSetting,
}));

const {
  detectHost,
  loadResourceSettings,
  maxDeployConcurrency,
  resetHostCache,
  saveResourceSettings,
  setResourceSettingsCache,
  tierCpuLimit,
  tierMemoryMb,
} = await import("@/lib/resources/host");

const GiB = 1024 ** 3;

beforeEach(() => {
  resetHostCache();
  setResourceSettingsCache();
  stored.raw = null;
  stored.fail = false;
  getSystemInfo.mockReset();
  delete process.env.VARDO_DEFAULT_MEMORY_STANDARD;
  delete process.env.VARDO_MAX_DEPLOY_CONCURRENCY;
});

describe("detectHost", () => {
  it("sizes defaults from Docker's /info", async () => {
    getSystemInfo.mockResolvedValue({ cpus: 32, memoryTotal: 125 * GiB });
    expect(await detectHost()).toEqual({ cpus: 32, memoryBytes: 125 * GiB });
    expect(tierMemoryMb("standard")).toBe(4096);
    expect(tierCpuLimit("standard")).toBe(31);
    expect(maxDeployConcurrency()).toBe(6);
  });

  it("caches the result", async () => {
    getSystemInfo.mockResolvedValue({ cpus: 4, memoryTotal: 7.6 * GiB });
    await detectHost();
    await detectHost();
    expect(getSystemInfo).toHaveBeenCalledTimes(1);
  });

  it("falls back to today's fixed defaults when Docker can't be read", async () => {
    getSystemInfo.mockRejectedValue(new Error("connect ENOENT /var/run/docker.sock"));
    expect(await detectHost()).toBeNull();
    expect(tierMemoryMb("standard")).toBe(1024);
    expect(tierMemoryMb("critical")).toBe(2048);
    expect(maxDeployConcurrency()).toBe(2);
  });

  it("lets an env var win over the detected value", async () => {
    getSystemInfo.mockResolvedValue({ cpus: 32, memoryTotal: 125 * GiB });
    await detectHost();
    process.env.VARDO_DEFAULT_MEMORY_STANDARD = "1536";
    process.env.VARDO_MAX_DEPLOY_CONCURRENCY = "3";
    expect(tierMemoryMb("standard")).toBe(1536);
    expect(maxDeployConcurrency()).toBe(3);
  });
});

describe("admin resource settings", () => {
  beforeEach(async () => {
    getSystemInfo.mockResolvedValue({ cpus: 32, memoryTotal: 125 * GiB });
    await detectHost();
  });

  it("win over the host rule once loaded", async () => {
    stored.raw = JSON.stringify({ memoryStandard: 3072, cpusStandard: 8, deployConcurrency: 9 });
    expect(tierMemoryMb("standard")).toBe(4096);
    await loadResourceSettings();
    expect(tierMemoryMb("standard")).toBe(3072);
    expect(tierCpuLimit("standard")).toBe(8);
    expect(maxDeployConcurrency()).toBe(9);
    expect(tierMemoryMb("critical")).toBe(8192);
  });

  it("lose to an env var", async () => {
    stored.raw = JSON.stringify({ memoryStandard: 3072 });
    await loadResourceSettings();
    process.env.VARDO_DEFAULT_MEMORY_STANDARD = "1536";
    expect(tierMemoryMb("standard")).toBe(1536);
  });

  it("apply on save without a reload", async () => {
    await saveResourceSettings({ deployConcurrency: 5 });
    expect(setSystemSetting).toHaveBeenCalledWith("resource_defaults", JSON.stringify({ deployConcurrency: 5 }));
    expect(maxDeployConcurrency()).toBe(5);
  });

  it("keep the last values when the database can't be read", async () => {
    stored.raw = JSON.stringify({ deployConcurrency: 7 });
    await loadResourceSettings();
    stored.fail = true;
    await loadResourceSettings();
    expect(maxDeployConcurrency()).toBe(7);
  });

  it("go back to the rule when cleared", async () => {
    stored.raw = JSON.stringify({ deployConcurrency: 7 });
    await loadResourceSettings();
    stored.raw = null;
    await loadResourceSettings();
    expect(maxDeployConcurrency()).toBe(6);
  });
});
