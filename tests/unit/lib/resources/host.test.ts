import { describe, it, expect, vi, beforeEach } from "vitest";

const getSystemInfo = vi.fn();
vi.mock("@/lib/docker/client", () => ({ getSystemInfo }));

const { detectHost, maxDeployConcurrency, resetHostCache, tierCpuLimit, tierMemoryMb } = await import(
  "@/lib/resources/host"
);

const GiB = 1024 ** 3;

beforeEach(() => {
  resetHostCache();
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
