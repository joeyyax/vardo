import { describe, expect, it } from "vitest";
import { CoreMemoryBuffer, coreMemoryObservations, isCoreContainer } from "@/lib/alerts/core-memory";
import type { ContainerMetrics } from "@/lib/metrics/types";

const MIN = 60_000;
const MiB = 1024 * 1024;
const now = 100 * MIN;

function metric(name: string, usageMb: number, at: number, opts: { limitMb?: number; labels?: Record<string, string> } = {}): ContainerMetrics {
  return {
    containerId: name.slice(0, 12),
    containerIdFull: "",
    containerName: name,
    projectName: "vardo",
    organizationId: null,
    labels: opts.labels ?? { "com.docker.compose.project": "vardo" },
    cpuPercent: 0,
    memoryUsage: usageMb * MiB,
    memoryLimit: (opts.limitMb ?? 512) * MiB,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    diskUsage: null,
    diskLimit: null,
    diskWriteBytes: null,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
    timestamp: at,
  };
}

/** One snapshot a minute for vardo-traefik, ending at `now`. */
function traefik(usagesMb: number[]): CoreMemoryBuffer {
  const buffer = new CoreMemoryBuffer();
  usagesMb.forEach((mb, i) => buffer.record([metric("vardo-traefik", mb, now - (usagesMb.length - 1 - i) * MIN)]));
  return buffer;
}

describe("core container memory alert", () => {
  it("fires when Traefik stays over 85% of its limit for five minutes", () => {
    const { evaluated, observations } = coreMemoryObservations(traefik([450, 450, 450, 450, 450, 450]), now);
    expect(evaluated).toEqual(["host.core-memory"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ type: "host.core-memory", about: "vardo-traefik", fires: true, severity: "warning" });
    expect(observations[0].item.title).toBe("Proxy (Traefik) is near its memory limit");
    expect(observations[0].item.next).toContain("VARDO_TRAEFIK_MEM");
  });

  it("doesn't fire on a spike", () => {
    const { observations } = coreMemoryObservations(traefik([200, 200, 200, 200, 500, 500]), now);
    expect(observations.every((o) => !o.fires)).toBe(true);
  });

  it("doesn't fire on a dip inside the window", () => {
    const { observations } = coreMemoryObservations(traefik([450, 450, 300, 450, 450, 450]), now);
    expect(observations.every((o) => !o.fires)).toBe(true);
  });

  it("is critical over 95% for the whole window", () => {
    const { observations } = coreMemoryObservations(traefik([500, 500, 500, 500, 500, 500]), now);
    expect(observations[0]).toMatchObject({ fires: true, severity: "critical" });
  });

  it("holds above 80% and clears below it", () => {
    expect(coreMemoryObservations(traefik([450, 450, 450, 450, 450, 420]), now).observations[0]).toMatchObject({ fires: false });
    expect(coreMemoryObservations(traefik([450, 450, 450, 450, 450, 400]), now).observations).toEqual([]);
  });

  it("settles nothing without a fresh reading", () => {
    expect(coreMemoryObservations(traefik([450, 450, 450, 450, 450, 450]), now + 10 * MIN)).toEqual({ evaluated: [], observations: [] });
  });

  it("counts a repeated snapshot once", () => {
    const buffer = new CoreMemoryBuffer();
    const snap = [metric("vardo-traefik", 450, now)];
    buffer.record(snap);
    buffer.record(snap);
    expect(buffer.entries()[0][1]).toHaveLength(1);
  });

  it("covers Vardo's own containers, not slot or app containers or unlimited ones", () => {
    expect(isCoreContainer(metric("vardo-traefik", 1, now))).toBe(true);
    expect(isCoreContainer(metric("/vardo-redis", 1, now))).toBe(true);
    expect(isCoreContainer(metric("vardo-production-blue-frontend-1", 1, now, { labels: { "vardo.project.id": "a1" } }))).toBe(false);
    expect(isCoreContainer(metric("blog-web-1", 1, now))).toBe(false);
    const buffer = new CoreMemoryBuffer();
    buffer.record([metric("vardo-postgres", 100, now, { limitMb: 0 })]);
    expect(buffer.entries()).toEqual([]);
  });
});
