import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
const collector = vi.hoisted(() => ({ running: false, snapshot: [] as unknown[] }));

vi.mock("@/lib/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  },
}));

vi.mock("@/lib/gpu/collector", () => ({
  getGpuCollector: () => (collector.running ? {} : null),
  getGpuSnapshot: () => collector.snapshot,
}));

import { GPU_SNAPSHOT_KEY, publishGpuSnapshot, readGpuSnapshot } from "@/lib/gpu/snapshot-store";

const gpu = {
  containerId: "c1",
  containerName: "web",
  projectName: "demo",
  organizationId: "org",
  gpuUtilization: 40,
  gpuMemoryUsed: 1,
  gpuMemoryTotal: 2,
  gpuTemperature: 60,
};

describe("the GPU snapshot web's live streams read", () => {
  beforeEach(() => {
    store.clear();
    collector.running = false;
    collector.snapshot = [];
  });

  it("comes from Redis when another process collects GPUs", async () => {
    await publishGpuSnapshot([gpu]);
    expect(await readGpuSnapshot()).toEqual([gpu]);
  });

  it("comes from memory when this process collects them", async () => {
    collector.running = true;
    collector.snapshot = [gpu];
    store.set(GPU_SNAPSHOT_KEY, "[]");
    expect(await readGpuSnapshot()).toEqual([gpu]);
  });

  it("is empty when nothing was published or the value is bad", async () => {
    expect(await readGpuSnapshot()).toEqual([]);
    store.set(GPU_SNAPSHOT_KEY, "{not json");
    expect(await readGpuSnapshot()).toEqual([]);
  });
});
