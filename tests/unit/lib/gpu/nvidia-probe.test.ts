import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { logMock } = vi.hoisted(() => ({
  logMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ logger: { child: () => logMock } }));

import {
  NvidiaProvider,
  PROBE_CONTAINER_NAME,
  SECTION_MARKER,
  SNAPSHOT_TTL_MS,
  FAILURE_THRESHOLD,
  BREAKER_COOLDOWN_MS,
  type CommandResult,
} from "@/lib/gpu/providers/nvidia";
import { GpuMetricsCollector } from "@/lib/gpu/collector";
import type { ContainerResolver } from "@/lib/gpu/types";

const PROBE_OUTPUT = [
  "0, GPU-1111, NVIDIA GeForce RTX 3060, 12288, 37, 4096, 55, 78.5, 42",
  SECTION_MARKER,
  "3210, GPU-1111, 2048",
].join("\n");

type Call = { cmd: string; args: string[] };

type FakeOptions = {
  /** Container status reported by `docker inspect`. */
  status?: string;
  /** Fail the `docker run` that starts the probe. */
  failRun?: boolean;
  /** Serve nvidia-smi from the local binary instead of a container. */
  localOutput?: string[];
  output?: string;
};

function fakeDocker(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  let local = opts.localOutput;

  const run = vi.fn(async (cmd: string, args: string[]): Promise<CommandResult> => {
    calls.push({ cmd, args });

    if (cmd === "nvidia-smi") {
      if (!local) return { ok: false, code: "ENOENT" };
      return { ok: true, stdout: local.shift() ?? "" };
    }

    switch (args[0]) {
      case "rm":
        return { ok: true, stdout: "" };
      case "run":
        return opts.failRun ? { ok: false } : { ok: true, stdout: "deadbeef\n" };
      case "inspect":
        return { ok: true, stdout: `${opts.status ?? "exited"}\n` };
      case "logs":
        return { ok: true, stdout: opts.output ?? PROBE_OUTPUT };
      default:
        return { ok: false };
    }
  });

  const setLocal = (lines: string[] | undefined) => {
    local = lines;
  };

  return {
    run,
    calls,
    setLocal,
    docker: (verb: string) => calls.filter((c) => c.cmd === "docker" && c.args[0] === verb),
  };
}

describe("NVIDIA probe container lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns exactly one probe container for a whole collector cycle", async () => {
    const fake = fakeDocker();
    const provider = new NvidiaProvider(fake.run);

    const [devices, metrics, processes] = await Promise.all([
      provider.detectDevices(),
      provider.getDeviceMetrics(),
      provider.getProcesses(),
    ]);

    expect(fake.docker("run")).toHaveLength(1);
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe("NVIDIA GeForce RTX 3060");
    expect(metrics[0].utilization).toBe(37);
    expect(metrics[0].temperature).toBe(55);
    expect(processes).toEqual([
      { pid: 3210, deviceIndex: 0, memoryUsed: 2048 * 1024 * 1024, type: "compute" },
    ]);
  });

  it("spawns one probe container per GpuMetricsCollector.collect()", async () => {
    const fake = fakeDocker();
    const resolver: ContainerResolver = {
      pidToContainerId: async () => "abc123456789",
      containerIdToApp: async () => ({
        projectName: "demo",
        containerName: "worker",
        organizationId: "org-1",
      }),
    };
    const collector = new GpuMetricsCollector(new NvidiaProvider(fake.run), resolver);

    const results = await collector.collect();

    expect(fake.docker("run")).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].gpuMemoryUsed).toBe(2048 * 1024 * 1024);
  });

  it("names the container and force-removes it before and after the run", async () => {
    const fake = fakeDocker();
    await new NvidiaProvider(fake.run).getDeviceMetrics();

    const runArgs = fake.docker("run")[0].args;
    expect(runArgs).toContain("-d");
    expect(runArgs).toContain("--name");
    expect(runArgs).toContain(PROBE_CONTAINER_NAME);
    expect(runArgs).not.toContain("--rm");

    const removals = fake.docker("rm");
    expect(removals).toHaveLength(2);
    expect(removals[0].args).toEqual(["rm", "-f", PROBE_CONTAINER_NAME]);

    // First removal clears any leftover, second cleans up this run.
    const order = fake.calls.map((c) => c.args[0]);
    expect(order.indexOf("rm")).toBeLessThan(order.indexOf("run"));
    expect(order.lastIndexOf("rm")).toBeGreaterThan(order.indexOf("run"));
  });

  it("force-removes the container when the probe never exits", async () => {
    const fake = fakeDocker({ status: "running" });
    const provider = new NvidiaProvider(fake.run);

    const pending = provider.getDeviceMetrics();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toEqual([]);
    expect(fake.docker("rm")).toHaveLength(2);
  });

  it("force-removes the container when the probe wedges in Dead state", async () => {
    const fake = fakeDocker({ status: "dead" });

    expect(await new NvidiaProvider(fake.run).getDeviceMetrics()).toEqual([]);
    expect(fake.docker("rm")).toHaveLength(2);
  });

  it("cleans up even when the container fails to start", async () => {
    const fake = fakeDocker({ failRun: true });

    expect(await new NvidiaProvider(fake.run).getDeviceMetrics()).toEqual([]);
    expect(fake.docker("rm")).toHaveLength(2);
  });

  it("reuses one probe inside the snapshot window, then re-probes", async () => {
    const fake = fakeDocker();
    const provider = new NvidiaProvider(fake.run);

    await provider.getDeviceMetrics();
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS - 1);
    await provider.getDeviceMetrics();
    expect(fake.docker("run")).toHaveLength(1);

    vi.advanceTimersByTime(SNAPSHOT_TTL_MS);
    await provider.getDeviceMetrics();
    expect(fake.docker("run")).toHaveLength(2);
  });
});

describe("NVIDIA probe circuit breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive `cycles` collector ticks, spacing them past the snapshot window. */
  async function tick(provider: NvidiaProvider, cycles: number) {
    for (let i = 0; i < cycles; i++) {
      await provider.getDeviceMetrics();
      vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    }
  }

  it("stops probing after repeated failures and logs the condition once", async () => {
    const fake = fakeDocker({ failRun: true });
    const provider = new NvidiaProvider(fake.run);

    await tick(provider, FAILURE_THRESHOLD + 5);

    expect(fake.docker("run")).toHaveLength(FAILURE_THRESHOLD);
    expect(provider.isProbeDisabled()).toBe(true);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining("GPU probing paused"));
  });

  it("retries once the cooldown elapses", async () => {
    const fake = fakeDocker({ failRun: true });
    const provider = new NvidiaProvider(fake.run);

    await tick(provider, FAILURE_THRESHOLD);
    expect(fake.docker("run")).toHaveLength(FAILURE_THRESHOLD);

    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS + 1);
    await tick(provider, 1);

    expect(fake.docker("run")).toHaveLength(FAILURE_THRESHOLD + 1);
    // Still broken — it goes quiet again without a second warning.
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(provider.isProbeDisabled()).toBe(true);
  });

  it("closes the breaker when the probe recovers", async () => {
    const fake = fakeDocker({ failRun: true });
    const provider = new NvidiaProvider(fake.run);

    await tick(provider, FAILURE_THRESHOLD);
    expect(provider.isProbeDisabled()).toBe(true);

    const healthy = fakeDocker();
    const recovered = new NvidiaProvider(healthy.run);
    await tick(recovered, 1);
    expect(recovered.isProbeDisabled()).toBe(false);
    expect(healthy.docker("run")).toHaveLength(1);
  });
});

describe("NVIDIA exec mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the local binary when it exists and never touches Docker", async () => {
    const fake = fakeDocker({
      localOutput: [
        "0, GPU-1111, NVIDIA GeForce RTX 3060, 12288, 37, 4096, 55, 78.5, 42\n",
        "3210, GPU-1111, 2048\n",
      ],
    });
    const provider = new NvidiaProvider(fake.run);

    const metrics = await provider.getDeviceMetrics();

    expect(metrics).toHaveLength(1);
    expect(fake.calls.every((c) => c.cmd === "nvidia-smi")).toBe(true);
  });

  it("falls back to Docker once, then stops retrying the missing binary", async () => {
    const fake = fakeDocker();
    const provider = new NvidiaProvider(fake.run);

    await provider.getDeviceMetrics();
    vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    await provider.getDeviceMetrics();

    expect(fake.calls.filter((c) => c.cmd === "nvidia-smi")).toHaveLength(1);
    expect(fake.docker("run")).toHaveLength(2);
  });
});
