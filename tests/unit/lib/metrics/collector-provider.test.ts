import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { CollectorClient, type CollectorContainer, type CollectorHost } from "@/lib/collector/client";
import {
  CollectorMetricsProvider,
  dockerLabelSource,
  mapCollectorContainers,
  sharedNetworkSource,
  staleAfterMs,
  WritableLayerSizes,
} from "@/lib/metrics/collector-provider";
import { aggregateContainers } from "@/lib/metrics/aggregate";

// Fixtures are real /api/v1 responses on OrbStack: collector 0.1.0, and 0.2.0 with the template's api_labels.
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8")) as T;
const containers = () => fixture<CollectorContainer[]>("collector-containers.json");
const host = () => fixture<CollectorHost>("collector-host.json");
const containers020 = () => fixture<CollectorContainer[]>("collector-0.2-containers.json");

const PROMTAIL_ID = "27c699e6dc7e473cb5142e9008a59f0e374a9f06226a5dfaf414f5bb35b953d3";
const POSTGRES_ID = "6a04ff5e6683dacbc726fed848e031e0aeb6d5039067066d528923b51dbdbb69";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapCollectorContainers", () => {
  const ts = 1_792_024_558_259;

  it("maps each value Vardo reads", () => {
    const [promtail] = mapCollectorContainers(containers(), { timestamp: ts }).filter((m) => m.containerIdFull === PROMTAIL_ID);
    expect(promtail).toEqual({
      containerId: "27c699e6dc7e",
      containerIdFull: PROMTAIL_ID,
      containerName: "promtail-production-green-promtail-1",
      projectName: "promtail",
      organizationId: null,
      labels: {
        "com.docker.compose.project": "promtail-production-green",
        "com.docker.compose.service": "promtail",
        "vardo.environment": "production",
        "vardo.project": "promtail",
      },
      cpuPercent: 1.31, // usage_cores 0.01305 as percent of one core
      memoryUsage: 56_774_656, // working set
      memoryLimit: 268_435_456,
      memoryPercent: 21.15,
      networkRxBytes: 10_794,
      networkTxBytes: 2380,
      diskUsage: null,
      diskLimit: null,
      diskWriteBytes: 2_292_596_736, // vdb; zram0 (swap) excluded
      processCount: null,
      gpuUtilization: 0,
      gpuMemoryUsed: 0,
      gpuMemoryTotal: 0,
      gpuTemperature: 0,
      timestamp: ts,
    });
  });

  it("sums disk writes over block devices and reads an unlimited memory limit as 0", () => {
    const pg = mapCollectorContainers(containers(), { timestamp: ts }).find((m) => m.containerIdFull === POSTGRES_ID)!;
    expect(pg.diskWriteBytes).toBe(8_058_892_288);
    expect(pg.projectName).toBe("vardo"); // compose project, with no Vardo label
    expect(pg.memoryLimit).toBe(1_073_741_824);
  });

  it("reads processCount from pids.processes, not the thread count in pids.current", () => {
    const rows = containers();
    rows[1].pids = { current: 42, limit: null, processes: 5 };
    const m = mapCollectorContainers(rows, { timestamp: ts }).find((r) => r.containerIdFull === rows[1].id)!;
    expect(m.processCount).toBe(5);
  });

  it("leaves processCount null from a collector that doesn't report processes", () => {
    const rows = containers();
    rows[1].pids = { current: 42, limit: null };
    rows[2].pids = { current: 42, limit: null, processes: null };
    const byId = new Map(mapCollectorContainers(rows, { timestamp: ts }).map((r) => [r.containerIdFull, r]));
    expect(byId.get(rows[1].id)!.processCount).toBeNull();
    expect(byId.get(rows[2].id)!.processCount).toBeNull();
  });

  it("drops containers with no project label", () => {
    const names = mapCollectorContainers(containers(), { timestamp: ts }).map((m) => m.containerName);
    expect(names).not.toContain("fixture-collector-a");
    expect(names).toHaveLength(2);
  });

  it("fills org and project id from Docker labels the collector's allowlist drops", () => {
    const dockerLabels = new Map([[PROMTAIL_ID, { "vardo.organization": "org-1", "vardo.project.id": "app-9", "traefik.enable": "false" }]]);
    const m = mapCollectorContainers(containers(), { timestamp: ts, dockerLabels }).find((r) => r.containerIdFull === PROMTAIL_ID)!;
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
    expect(byId.get(PROMTAIL_ID)!.networkRxBytes).toBe(10_804);
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
    const sizes = { read: vi.fn(async () => new Map([[PROMTAIL_ID, { bytes: 4096, at: 1_000 }]])) } as unknown as WritableLayerSizes;
    const rows = await new CollectorMetricsProvider(new CollectorClient("http://c"), { sizes }).fetchAll();
    const m = rows.find((r) => r.containerIdFull === PROMTAIL_ID)!;
    expect([m.diskUsage, m.diskUsageAt, m.diskLimit]).toEqual([4096, 1_000, null]);
    expect(rows.find((r) => r.containerIdFull === POSTGRES_ID)!.diskUsage).toBeNull();
  });

  it("counts a shared network namespace once, on its owner", async () => {
    // Long House: Qbittorrent runs with `network_mode: service:gluetun` and reads Gluetun's counters.
    const rows = containers();
    const owner = rows.find((c) => c.id === PROMTAIL_ID)!;
    rows.find((c) => c.id === POSTGRES_ID)!.network = owner.network;
    stubCollector({ host: fresh(), containers: rows });
    const sharedNetwork = vi.fn(async () => new Set([POSTGRES_ID]));

    const metrics = await new CollectorMetricsProvider(new CollectorClient("http://c"), { sharedNetwork }).fetchAll();

    expect(sharedNetwork).toHaveBeenCalledWith([PROMTAIL_ID, POSTGRES_ID]);
    expect(metrics.find((m) => m.containerIdFull === POSTGRES_ID)).toMatchObject({ sharedNetwork: true, networkRxBytes: 0, networkTxBytes: 0 });
    expect(metrics.find((m) => m.containerIdFull === PROMTAIL_ID)!.sharedNetwork).toBeUndefined();
    expect(aggregateContainers(metrics)).toMatchObject({ networkRx: 10_794, networkTx: 2380 });
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
    const m = (await new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll()).find((r) => r.containerIdFull === PROMTAIL_ID)!;
    expect(m.organizationId).toBe("bHLg3AbBrUFsUexeKZw0M");
    expect(m.labels["vardo.project.id"]).toBe("FcZdxGloVT1bYD3rfZhOA");
  });

  it("still joins Docker labels for a collector without api_labels", async () => {
    stubCollector({ host: { ...host(), timestamp: Date.now() / 1000 - 3 } });
    const dockerLabels = vi.fn(async () => new Map([[PROMTAIL_ID, { "vardo.organization": "org-1" }]]));
    const rows = await new CollectorMetricsProvider(new CollectorClient("http://c"), { dockerLabels }).fetchAll();
    expect(dockerLabels).toHaveBeenCalledOnce();
    expect(rows.find((r) => r.containerIdFull === PROMTAIL_ID)!.organizationId).toBe("org-1");
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
    rows.find((c) => c.id === PROMTAIL_ID)!.gpus = [{ uuid: "GPU-abc", memory_used_bytes: 1024 }];
    stubCollector({ containers: rows });
    const metrics = await new CollectorMetricsProvider(new CollectorClient("http://c")).fetchAll();
    expect(metrics.find((r) => r.containerIdFull === PROMTAIL_ID)!.gpus).toEqual([{ uuid: "GPU-abc", memoryUsedBytes: 1024 }]);
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

describe("sharedNetworkSource", () => {
  // Long House: Port Sync and Qbittorrent run with `network_mode: service:gluetun`.
  const GLUETUN = "65bcc5b5350843e28ca24dc5816af2374b76c2348e3272c8b57f3df661950bde";
  const modes: Record<string, string> = { gluetun: "transmission-production-blue_default", "port-sync": `container:${GLUETUN}`, qbittorrent: `container:${GLUETUN}` };

  it("picks out containers on another container's network, inspecting each once", async () => {
    const inspect = vi.fn(async (id: string) => modes[id]);
    const shared = sharedNetworkSource(inspect);
    expect(await shared(["gluetun", "port-sync", "qbittorrent"])).toEqual(new Set(["port-sync", "qbittorrent"]));
    expect(await shared(["gluetun", "port-sync", "qbittorrent"])).toEqual(new Set(["port-sync", "qbittorrent"]));
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("counts a container it can't inspect as its own, and asks again", async () => {
    const inspect = vi.fn(async (id: string) => {
      if (inspect.mock.calls.length === 1) throw new Error("timeout");
      return modes[id];
    });
    const shared = sharedNetworkSource(inspect);
    expect(await shared(["port-sync"])).toEqual(new Set());
    expect(await shared(["port-sync"])).toEqual(new Set(["port-sync"]));
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
