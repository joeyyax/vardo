import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

import { FallbackMetricsProvider } from "@/lib/metrics/fallback-provider";
import type { MetricsProvider } from "@/lib/metrics/provider";
import type { ContainerMetrics } from "@/lib/metrics/types";

const row = (name: string) => ({ containerName: name }) as ContainerMetrics;

function providers() {
  const primary = { name: "collector", pollIntervalMs: 15_000, fetchAll: vi.fn(async () => [row("from-collector")]) } satisfies MetricsProvider;
  const fallback = { name: "cAdvisor", fetchAll: vi.fn(async () => [row("from-cadvisor")]) } satisfies MetricsProvider;
  return { primary, fallback };
}

describe("FallbackMetricsProvider", () => {
  it("reads the collector while it answers", async () => {
    const { primary, fallback } = providers();
    const p = new FallbackMetricsProvider(primary, fallback);
    expect((await p.fetchAll())[0].containerName).toBe("from-collector");
    expect(fallback.fetchAll).not.toHaveBeenCalled();
    expect(p.pollIntervalMs).toBe(15_000);
  });

  it("serves cAdvisor when the collector fails, and skips the collector until the retry", async () => {
    let t = 0;
    const { primary, fallback } = providers();
    primary.fetchAll.mockRejectedValue(new Error("ECONNREFUSED"));
    const p = new FallbackMetricsProvider(primary, fallback, { retryMs: 60_000, now: () => t });

    expect((await p.fetchAll())[0].containerName).toBe("from-cadvisor");
    expect(p.isFallingBack()).toBe(true);
    // cAdvisor's own 5s cadence while it serves.
    expect(p.pollIntervalMs).toBeUndefined();

    t = 30_000;
    await p.fetchAll();
    expect(primary.fetchAll).toHaveBeenCalledTimes(1);

    t = 61_000;
    primary.fetchAll.mockResolvedValue([row("from-collector")]);
    expect((await p.fetchAll())[0].containerName).toBe("from-collector");
    expect(p.isFallingBack()).toBe(false);
  });

  it("fails only when both sources fail", async () => {
    const { primary, fallback } = providers();
    primary.fetchAll.mockRejectedValue(new Error("down"));
    fallback.fetchAll.mockRejectedValue(new Error("cadvisor down"));
    await expect(new FallbackMetricsProvider(primary, fallback).fetchAll()).rejects.toThrow("cadvisor down");
  });
});
