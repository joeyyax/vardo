import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = new Map<string, number>();
const emit = vi.fn();

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/docker/oom-counter", () => ({
  readFleetOomKills: async () => [...counts.values()].reduce((a, b) => a + b, 0),
  readContainerOomKills: async (id: string) => counts.get(id) ?? 0,
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit }));

const { tickOomWatch, resetOomWatch } = await import("@/lib/docker/oom-watch");

const subject = {
  organizationId: "org1",
  appId: "app1",
  appName: "Worker",
  containerId: "c1",
  containerName: "worker-1",
  memoryLimit: 512 * 1024 * 1024,
};

describe("tickOomWatch after a restart", () => {
  beforeEach(() => {
    resetOomWatch();
    counts.clear();
    emit.mockClear();
  });

  it("takes the first reading as a baseline instead of re-reporting old kills", async () => {
    counts.set("c1", 1);
    await tickOomWatch([subject], 1_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it("reports kills that happen after the baseline", async () => {
    counts.set("c1", 1);
    await tickOomWatch([subject], 1_000);
    counts.set("c1", 2);
    await tickOomWatch([subject], 2_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
