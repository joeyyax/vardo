import { describe, it, expect, vi, beforeEach } from "vitest";

const { nvidiaCtor, detectDevices, dockerRequestMock } = vi.hoisted(() => ({
  nvidiaCtor: vi.fn(),
  detectDevices: vi.fn(),
  dockerRequestMock: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/gpu/providers/nvidia", () => ({
  NvidiaProvider: class {
    vendor = "nvidia";
    constructor() {
      nvidiaCtor();
    }
    detectDevices = detectDevices;
    getDeviceMetrics = vi.fn(async () => []);
    getProcesses = vi.fn(async () => []);
  },
}));
vi.mock("@/lib/gpu/resolver", () => ({ DockerContainerResolver: class {} }));
vi.mock("@/lib/docker/client", () => ({ dockerRequest: dockerRequestMock }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: vi.fn(async () => null) }));

import type { CollectorClient, CollectorGpu } from "@/lib/collector/client";
import {
  attributeGpuMemory,
  attributeGpus,
  CollectorGpuCollector,
  FallbackGpuCollector,
  gpuAccess,
  type ContainerGpuSource,
} from "@/lib/gpu/collector-source";
import { initGpuCollector } from "@/lib/gpu/collector";
import type { ContainerMetrics } from "@/lib/metrics/types";

// The device row from the collector's docs/api.md.
const RTX: CollectorGpu = {
  index: 0,
  uuid: "00000000-0000-0000-0000-000000000000",
  name: "NVIDIA GeForce RTX 3060",
  temperature_celsius: 37.0,
  utilization_ratio: 0.4,
  memory_utilization_ratio: 0.0,
  memory_used_bytes: 2_000_000_000,
  memory_total_bytes: 12_884_901_888,
  power_draw_watts: 14.05,
  fan_speed_ratio: 0.3,
};

const container = (name: string, id: string, labels: Record<string, string> = {}) =>
  ({
    containerId: id.slice(0, 12),
    containerIdFull: id,
    containerName: name,
    projectName: name,
    organizationId: "org-1",
    labels,
  }) as ContainerMetrics;

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);

describe("gpuAccess", () => {
  it("reads --gpus all and compose device reservations", () => {
    expect(gpuAccess({ HostConfig: { DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }] } })).toBe("all");
    expect(gpuAccess({ HostConfig: { DeviceRequests: [{ Driver: "", Count: 0, DeviceIDs: ["GPU-ABC", "1"], Capabilities: [["gpu"]] }] } })).toEqual(["abc", "1"]);
  });

  it("reads runtime: nvidia with NVIDIA_VISIBLE_DEVICES", () => {
    expect(gpuAccess({ HostConfig: { Runtime: "nvidia" }, Config: { Env: ["NVIDIA_VISIBLE_DEVICES=all"] } })).toBe("all");
    expect(gpuAccess({ HostConfig: { Runtime: "nvidia" }, Config: { Env: ["NVIDIA_VISIBLE_DEVICES=0,1"] } })).toEqual(["0", "1"]);
    expect(gpuAccess({ HostConfig: { Runtime: "nvidia" }, Config: { Env: ["NVIDIA_VISIBLE_DEVICES=void"] } })).toBeNull();
  });

  it("gives a plain container no GPU", () => {
    expect(gpuAccess({ HostConfig: { Runtime: "runc", DeviceRequests: null } })).toBeNull();
  });
});

describe("attributeGpus", () => {
  it("gives a GPU's sole user its full readings, in Vardo's units", () => {
    const [m] = attributeGpus([RTX], [{ metrics: container("plex", ID_A), access: "all" }]);
    expect(m).toEqual({
      containerId: ID_A.slice(0, 12),
      containerName: "plex",
      projectName: "plex",
      organizationId: "org-1",
      gpuUtilization: 40,
      gpuMemoryUsed: 2_000_000_000,
      gpuMemoryTotal: 12_884_901_888,
      gpuTemperature: 37,
    });
  });

  it("splits a shared GPU evenly and skips containers without one", () => {
    const rows = attributeGpus([RTX], [
      { metrics: container("plex", ID_A), access: "all" },
      { metrics: container("ollama", ID_B), access: ["0"] },
      { metrics: container("web", ID_C), access: null },
    ]);
    expect(rows.map((r) => [r.containerName, r.gpuUtilization, r.gpuMemoryUsed])).toEqual([
      ["plex", 20, 1_000_000_000],
      ["ollama", 20, 1_000_000_000],
    ]);
  });
});

describe("attributeGpuMemory", () => {
  const withGpus = (name: string, id: string, gpus: ContainerMetrics["gpus"]) => ({ ...container(name, id), gpus });

  it("gives each container its own memory and splits utilization by it", () => {
    const rows = attributeGpuMemory([RTX], [
      withGpus("ollama", ID_A, [{ uuid: `GPU-${RTX.uuid}`, memoryUsedBytes: 1_500_000_000 }]),
      withGpus("plex", ID_B, [{ uuid: RTX.uuid, memoryUsedBytes: 500_000_000 }]),
      withGpus("web", ID_C, []),
    ]);
    expect(rows.map((r) => [r.containerName, r.gpuUtilization, r.gpuMemoryUsed, r.gpuMemoryTotal])).toEqual([
      ["ollama", 30, 1_500_000_000, 12_884_901_888],
      ["plex", 10, 500_000_000, 12_884_901_888],
    ]);
  });

  it("ignores memory on a device the host doesn't report", () => {
    expect(attributeGpuMemory([RTX], [withGpus("x", ID_A, [{ uuid: "other", memoryUsedBytes: 1 }])])).toEqual([]);
  });
});

describe("CollectorGpuCollector", () => {
  const client = (gpus: CollectorGpu[]) => ({ host: vi.fn(async () => ({ host: "lab", timestamp: 0, gpus })) }) as unknown as CollectorClient;

  it("uses per-container memory without inspecting anything", async () => {
    const inspect = vi.fn();
    const source = new CollectorGpuCollector(client([RTX]), inspect);
    const rows = await source.collect([
      { ...container("ollama", ID_A), gpus: [{ uuid: RTX.uuid, memoryUsedBytes: 1_000 }] },
      { ...container("plex", ID_B), gpus: [] },
    ]);
    expect(rows.map((r) => [r.containerName, r.gpuMemoryUsed, r.gpuUtilization])).toEqual([["ollama", 1_000, 40]]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("falls back to the even split when no container reports GPU memory, as without pid: host", async () => {
    const inspect = vi.fn(async () => ({ HostConfig: { DeviceRequests: [{ Driver: "nvidia", Count: -1 }] } }));
    const source = new CollectorGpuCollector(client([RTX]), inspect);
    const rows = await source.collect([{ ...container("plex", ID_A), gpus: [] }, { ...container("ollama", ID_B), gpus: [] }]);
    expect(rows.map((r) => [r.containerName, r.gpuMemoryUsed])).toEqual([["plex", 1_000_000_000], ["ollama", 1_000_000_000]]);
  });

  it("reads devices from the collector and inspects each container once", async () => {
    const inspect = vi.fn(async (id: string) =>
      id === ID_A ? { HostConfig: { DeviceRequests: [{ Driver: "nvidia", Count: -1 }] } } : { HostConfig: {} },
    );
    const source = new CollectorGpuCollector(client([RTX]), inspect);
    const snapshot = [container("plex", ID_A), container("web", ID_B)];

    expect((await source.collect(snapshot)).map((r) => r.containerName)).toEqual(["plex"]);
    await source.collect(snapshot);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("leaves the collector's own container out", async () => {
    const inspect = vi.fn(async () => ({ HostConfig: { Runtime: "nvidia" }, Config: { Env: ["NVIDIA_VISIBLE_DEVICES=all"] } }));
    const source = new CollectorGpuCollector(client([RTX]), inspect);
    const rows = await source.collect([container("collector", ID_A), container("x", ID_B, { "com.docker.compose.service": "collector" })]);
    expect(rows).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("returns nothing and inspects nothing on a host without GPUs", async () => {
    const inspect = vi.fn();
    expect(await new CollectorGpuCollector(client([]), inspect).collect([container("plex", ID_A)])).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("FallbackGpuCollector — source switch", () => {
  const reading = (name: string) => [{ containerName: name }] as Awaited<ReturnType<ContainerGpuSource["collect"]>>;

  it("never starts the probe while the collector answers, even with no GPUs", async () => {
    const initProbe = vi.fn();
    const source = new FallbackGpuCollector({ collect: async () => [] }, initProbe);
    await source.collect([]);
    await source.collect([]);
    expect(initProbe).not.toHaveBeenCalled();
  });

  it("starts the probe once when the collector fails, then goes back to the collector", async () => {
    let t = 0;
    const primary = { collect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const probe = { collect: vi.fn(async () => reading("from-probe")) };
    const initProbe = vi.fn(async () => probe);
    const source = new FallbackGpuCollector(primary, initProbe, { retryMs: 60_000, now: () => t });

    expect(await source.collect([])).toEqual(reading("from-probe"));
    t = 10_000;
    await source.collect([]);
    expect(initProbe).toHaveBeenCalledTimes(1);
    expect(primary.collect).toHaveBeenCalledTimes(1);

    t = 61_000;
    primary.collect.mockResolvedValue(reading("from-collector"));
    expect(await source.collect([])).toEqual(reading("from-collector"));
    expect(source.isFallingBack()).toBe(false);
  });

  it("reports no readings when the collector fails on a host the probe finds no GPU on", async () => {
    const source = new FallbackGpuCollector({ collect: vi.fn().mockRejectedValue(new Error("down")) }, async () => null);
    expect(await source.collect([])).toEqual([]);
  });
});

describe("initGpuCollector", () => {
  beforeEach(() => {
    nvidiaCtor.mockReset();
    detectDevices.mockReset();
    (globalThis as { __vardo_gpu_collector?: unknown }).__vardo_gpu_collector = undefined;
  });

  it("uses the collector and doesn't touch the nvidia-smi probe when one is configured", async () => {
    const source = await initGpuCollector({ VARDO_COLLECTOR_URL: "http://collector:9273" });
    expect(source).toBeInstanceOf(FallbackGpuCollector);
    expect(nvidiaCtor).not.toHaveBeenCalled();
  });

  it("keeps the probe with the collector off", async () => {
    detectDevices.mockResolvedValue([{ index: 0, uuid: "x", name: "RTX", memoryTotal: 1, vendor: "nvidia" }]);
    const source = await initGpuCollector({ VARDO_COLLECTOR_IMAGE: "off" });
    expect(source).not.toBeInstanceOf(FallbackGpuCollector);
    expect(nvidiaCtor).toHaveBeenCalledTimes(1);
  });
});
