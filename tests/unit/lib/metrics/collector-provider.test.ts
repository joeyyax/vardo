import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { CollectorClient, type CollectorContainer, type CollectorHost } from "@/lib/collector/client";
import {
  CollectorMetricsProvider,
  dockerLabelSource,
  mapCollectorContainers,
  staleAfterMs,
  WritableLayerSizes,
} from "@/lib/metrics/collector-provider";

// Fixtures are real /api/v1 responses on OrbStack: collector 3d51106 (0.1.0) and 0.2.0 with the template's api_labels.
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8")) as T;
const containers = () => fixture<CollectorContainer[]>("collector-containers.json");
const host = () => fixture<CollectorHost>("collector-host.json");
const containers020 = () => fixture<CollectorContainer[]>("collector-0.2-containers.json");

const CADVISOR_ID = "2f6b7dda317349d1d84c09f510fad4329ddb7e080d2d3c3ab103471b0e828537";
const POSTGRES_ID = "6a04ff5e6683dacbc726fed848e031e0aeb6d5039067066d528923b51dbdbb69";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapCollectorContainers", () => {
  const ts = 1_792_024_558_259;

  it("maps each value Vardo reads from cAdvisor", () => {
    const [cadvisor] = mapCollectorContainers(containers(), { timestamp: ts }).filter((m) => m.containerIdFull === CADVISOR_ID);
    expect(cadvisor).toEqual({
      containerId: "2f6b7dda3173",
      containerIdFull: CADVISOR_ID,
      containerName: "cadvisor-production-green-cadvisor-1",
      projectName: "cadvisor",
      organizationId: null,
      labels: {
        "com.docker.compose.project": "cadvisor-production-green",
        "com.docker.compose.service": "cadvisor",
        "vardo.environment": "production",
        "vardo.project": "cadvisor",
      },
      cpuPercent: 0.11, // usage_cores 0.00108 as percent of one core
      memoryUsage: 20_815_872, // working set, as cAdvisor
      memoryLimit: 268_435_456,
      memoryPercent: 7.75,
      networkRxBytes: 4604,
      networkTxBytes: 2170,
      diskUsage: null,
      diskLimit: null,
      diskWriteBytes: 0, // zram0 (swap) excluded; vda and vdb wrote nothing
      processCount: 15,
      gpuUtilization: 0,
      gpuMemoryUsed: 0,
      gpuMemoryTotal: 0,
      gpuTemperature: 0,
      timestamp: ts,
    });
  });

  it("sums disk writes over block devices and reads an unlimited memory limit as 0", () => {
    const pg = mapCollectorContainers(containers(), { timestamp: ts }).find((m) => m.containerIdFull === POSTGRES_ID)!;
    expect(pg.diskWriteBytes).toBe(5_099_610_112);
    expect(pg.projectName).toBe("vardo"); // compose project, as cAdvisor falls back to
    expect(pg.memoryLimit).toBe(1_073_741_824);
  });

  it("drops containers with no project label, as cAdvisor's reader does", () => {
    const names = mapCollectorContainers(containers(), { timestamp: ts }).map((m) => m.containerName);
    expect(names).not.toContain("bmpr-sampler");
    expect(names).toHaveLength(2);
  });

  it("fills org and project id from Docker labels the collector's allowlist drops", () => {
    const dockerLabels = new Map([[CADVISOR_ID, { "vardo.organization": "org-1", "vardo.project.id": "app-9", "traefik.enable": "false" }]]);
    const m = mapCollectorContainers(containers(), { timestamp: ts, dockerLabels }).find((r) => r.containerIdFull === CADVISOR_ID)!;
    expect(m.organizationId).toBe("org-1");
    expect(m.labels["vardo.project.id"]).toBe("app-9");
    expect(m.labels["traefik.enable"]).toBeUndefined();
  });

  it("leaves out a container whose CPU rate isn't known yet rather than showing 0%", () => {
    const rows = containers();
    rows[1].cpu.usage_cores = null;
    const ids = mapCollectorContainers(rows, { timestamp: ts }).map((m) => m.containerIdFull);
    expect(ids).not.toContain(rows[1].id);
  });

  it("sums every interface and reports no network for a host-network container", () => {
    const rows = containers();
    rows[1].network.push({ interface: "eth1", receive_bytes_total: 10, transmit_bytes_total: 20, receive_bytes_per_second: null, transmit_bytes_per_second: null });
    rows[2].network = [];
    const byId = new Map(mapCollectorContainers(rows, { timestamp: ts }).map((m) => [m.containerIdFull, m]));
    expect(byId.get(CADVISOR_ID)!.networkRxBytes).toBe(4614);
    expect(byId.get(POSTGRES_ID)!.networkRxBytes).toBe(0);
  });
});

/** A fetch stub serving the collector's endpoints. */
function stubCollector(opts: { host?: CollectorHost | 503; health?: object; containers?: CollectorContainer[] } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (path === "/api/v1/host") return opts.host === 503 ? json(503, { error: "no data yet" }) : json(200, opts.host ?? host());
    if (path === "/api/v1/containers") return json(200, opts.containers ?? containers());
    if (path === "/health") return json(200, opts.health ?? {});
    void init;
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CollectorMetricsProvider", () => {
  const fresh = () => ({ ...host(), timestamp: Date.now() / 1000 - 3 });

  it("stamps rows with the collection time and sends the bearer token", async () => {
    const h = fresh();
    const fetchMock = stubCollector({ host: h });
    const provider = new CollectorMetricsProvider(new CollectorClient("http://collector:9273", async () => "tok"));

    const rows = await provider.fetchAll();

    expect(rows).toHaveLength(2);
    expect(rows[0].timestamp).toBe(Math.round(h.timestamp * 1000));
    const headers = fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization);
    expect(headers).toEqual(["Bearer tok", "Bearer tok"]);
  });

  it("polls at 15s until a 0.2.0 collector reports its interval", () => {
    expect(new CollectorMetricsProvider(new CollectorClient("http://c")).pollIntervalMs).toBe(15_000);
  });

  it("throws on a stale collection so the fallback serves", async () => {
    stubCollector({ host: { ...host(), timestamp: (Date.now() - staleAfterMs(15_000) - 1000) / 1000 } });
    await expect(new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).rejects.toThrow(/stale/);
  });

  it("throws before the collector's second collection, when no container has a rate", async () => {
    const rows = containers().map((c) => ({ ...c, cpu: { ...c.cpu, usage_cores: null } }));
    stubCollector({ host: fresh(), containers: rows });
    await expect(new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).rejects.toThrow(/no rates yet/);
  });

  it("reads the collection time from /health when host metrics are off", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    stubCollector({ host: 503, health: { status: "ok", last_collect_age_seconds: 4.2 } });
    const rows = await new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll();
    expect(rows[0].timestamp).toBe(1_800_000_000_000 - 4000);
  });

  it("propagates an auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) })));
    await expect(new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).rejects.toThrow(/401/);
  });

  it("adds Docker's writable-layer size and when it was measured", async () => {
    stubCollector({ host: fresh() });
    const sizes = { read: vi.fn(async () => new Map([[CADVISOR_ID, { bytes: 4096, at: 1_000 }]])) } as unknown as WritableLayerSizes;
    const rows = await new CollectorMetricsProvider(new CollectorClient("http://c"), { sizes }).fetchAll();
    const m = rows.find((r) => r.containerIdFull === CADVISOR_ID)!;
    expect([m.diskUsage, m.diskUsageAt, m.diskLimit]).toEqual([4096, 1_000, null]);
    expect(rows.find((r) => r.containerIdFull === POSTGRES_ID)!.diskUsage).toBeNull();
  });
});

describe("CollectorMetricsProvider on 0.2.0", () => {
  /** The 0.2.0 fixture, collected `ageSeconds` ago at this interval. */
  const at = (ageSeconds: number, intervalSeconds = 15) =>
    containers020().map((c) => ({ ...c, collected_at: Date.now() / 1000 - ageSeconds, interval_seconds: intervalSeconds }));

  it("reads only /api/v1/containers and stamps rows with collected_at", async () => {
    const rows = at(3);
    const fetchMock = stubCollector({ containers: rows });
    const dockerLabels = vi.fn(async () => new Map());

    const metrics = await new CollectorMetricsProvider(new CollectorClient("http://c"), { dockerLabels }).fetchAll();

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/containers"]);
    expect(dockerLabels).not.toHaveBeenCalled();
    expect(metrics[0].timestamp).toBe(Math.round(rows[0].collected_at! * 1000));
  });

  it("takes org and app id from api_labels", async () => {
    stubCollector({ containers: at(3) });
    const m = (await new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).find((r) => r.containerIdFull === CADVISOR_ID)!;
    expect(m.organizationId).toBe("bHLg3AbBrUFsUexeKZw0M");
    expect(m.labels["vardo.project.id"]).toBe("PUi2_6S4t9W4I10Y61cdZ");
  });

  it("still joins Docker labels for a collector without api_labels", async () => {
    stubCollector({ host: { ...host(), timestamp: Date.now() / 1000 - 3 } });
    const dockerLabels = vi.fn(async () => new Map([[CADVISOR_ID, { "vardo.organization": "org-1" }]]));
    const rows = await new CollectorMetricsProvider(new CollectorClient("http://c"), { dockerLabels }).fetchAll();
    expect(dockerLabels).toHaveBeenCalledOnce();
    expect(rows.find((r) => r.containerIdFull === CADVISOR_ID)!.organizationId).toBe("org-1");
  });

  it("judges staleness against interval_seconds and polls at it", async () => {
    stubCollector({ containers: at(100, 15) });
    await expect(new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).rejects.toThrow(/stale/);

    stubCollector({ containers: at(100, 60) });
    const provider = new CollectorMetricsProvider(new CollectorClient("http://c"));
    await expect(provider.fetchAll()).resolves.toHaveLength(2);
    expect(provider.pollIntervalMs).toBe(60_000);
  });

  it("returns nothing for no containers without another call", async () => {
    const fetchMock = stubCollector({ containers: [] });
    await expect(new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports its first serve once, and not before it has metrics", async () => {
    const onFirstServe = vi.fn();
    const provider = new CollectorMetricsProvider(new CollectorClient("http://c"), { onFirstServe });
    stubCollector({ containers: [] });
    await provider.fetchAll();
    expect(onFirstServe).not.toHaveBeenCalled();
    stubCollector({ containers: at(3) });
    await provider.fetchAll();
    await provider.fetchAll();
    expect(onFirstServe).toHaveBeenCalledOnce();
  });

  it("carries per-container GPU memory", async () => {
    const rows = at(3);
    rows.find((c) => c.id === CADVISOR_ID)!.gpus = [{ uuid: "GPU-abc", memory_used_bytes: 1024 }];
    stubCollector({ containers: rows });
    const metrics = await new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll();
    expect(metrics.find((r) => r.containerIdFull === CADVISOR_ID)!.gpus).toEqual([{ uuid: "GPU-abc", memoryUsedBytes: 1024 }]);
    expect(metrics.find((r) => r.containerIdFull === POSTGRES_ID)!.gpus).toEqual([]);
  });
});

describe("dockerLabelSource", () => {
  it("inspects each container once and forgets ones that are gone", async () => {
    const inspect = vi.fn(async (id: string) => ({ "vardo.organization": `org-${id}` }));
    const source = dockerLabelSource(inspect);

    expect((await source(["a", "b"])).get("a")).toEqual({ "vardo.organization": "org-a" });
    await source(["a", "b"]);
    expect(inspect).toHaveBeenCalledTimes(2);

    const labels = await source(["b", "c"]);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(labels.has("a")).toBe(false);
  });

  it("tries a failed inspect again on the next poll", async () => {
    const inspect = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue({ x: "1" });
    const source = dockerLabelSource(inspect);
    expect((await source(["a"])).has("a")).toBe(false);
    expect((await source(["a"])).get("a")).toEqual({ x: "1" });
  });
});

describe("WritableLayerSizes", () => {
  const HOUR = 60 * 60_000;

  it("never asks Docker for a size while Disk metrics are off", async () => {
    const inspectSize = vi.fn(async () => 1);
    const sizes = new WritableLayerSizes(inspectSize, async () => false);
    for (let i = 0; i < 5; i++) expect((await sizes.read(["a", "b"])).size).toBe(0);
    await sizes.settle();
    expect(inspectSize).not.toHaveBeenCalled();
  });

  it("measures one container at a time, spread across the hour, and caches each for an hour", async () => {
    let t = 0;
    const inspectSize = vi.fn(async (id: string) => (id === "a" ? 100 : 200));
    const sizes = new WritableLayerSizes(inspectSize, async () => true, { periodMs: HOUR, now: () => t });
    const ids = ["a", "b"];

    await sizes.read(ids);
    await sizes.settle();
    expect(inspectSize).toHaveBeenCalledTimes(1);

    // The next one waits half the hour (an hour over two containers).
    t = 10 * 60_000;
    await sizes.read(ids);
    expect(inspectSize).toHaveBeenCalledTimes(1);

    t = 30 * 60_000;
    await sizes.read(ids);
    await sizes.settle();
    expect(inspectSize).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(await sizes.read(ids))).toEqual({ a: { bytes: 100, at: 0 }, b: { bytes: 200, at: 30 * 60_000 } });

    // Both fresh: nothing until a's hour is up.
    t = 59 * 60_000;
    await sizes.read(ids);
    expect(inspectSize).toHaveBeenCalledTimes(2);
    t = 61 * 60_000;
    await sizes.read(ids);
    await sizes.settle();
    expect(inspectSize).toHaveBeenLastCalledWith("a");
  });

  it("drops cached sizes when Disk metrics are turned off", async () => {
    let on = true;
    const sizes = new WritableLayerSizes(async () => 5, async () => on);
    await sizes.read(["a"]);
    await sizes.settle();
    expect((await sizes.read(["a"])).size).toBe(1);
    on = false;
    expect((await sizes.read(["a"])).size).toBe(0);
  });
});
