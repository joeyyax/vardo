import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { CollectorClient, type CollectorContainer, type CollectorHost } from "@/lib/collector/client";
import {
  CollectorMetricsProvider,
  dockerLabelSource,
  mapCollectorContainers,
  STALE_AFTER_MS,
} from "@/lib/metrics/collector-provider";
import type { MetricsProvider } from "@/lib/metrics/provider";
import type { ContainerMetrics } from "@/lib/metrics/types";

// Fixtures are real /api/v1 responses from collector 3d51106 on OrbStack.
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8")) as T;
const containers = () => fixture<CollectorContainer[]>("collector-containers.json");
const host = () => fixture<CollectorHost>("collector-host.json");

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

  it("polls at the collector's 15s interval", () => {
    expect(new CollectorMetricsProvider(new CollectorClient("http://c")).pollIntervalMs).toBe(15_000);
  });

  it("throws on a stale collection so the fallback serves", async () => {
    stubCollector({ host: { ...host(), timestamp: (Date.now() - STALE_AFTER_MS - 1000) / 1000 } });
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

  it("takes per-container disk from cAdvisor only when its disk metrics are on", async () => {
    stubCollector({ host: fresh() });
    const cadvisorRow = { containerId: "2f6b7dda3173", containerIdFull: CADVISOR_ID, diskUsage: 123, diskLimit: 456 } as ContainerMetrics;
    const cadvisor: MetricsProvider = { fetchAll: vi.fn(async () => [cadvisorRow]) };
    let on = false;
    const provider = new CollectorMetricsProvider(new CollectorClient("http://c"), {
      disk: { enabled: async () => on, provider: cadvisor },
    });

    const off = await provider.fetchAll();
    expect(off.every((m) => m.diskUsage === null)).toBe(true);
    expect(cadvisor.fetchAll).not.toHaveBeenCalled();

    on = true;
    const withDisk = await provider.fetchAll();
    const m = withDisk.find((r) => r.containerIdFull === CADVISOR_ID)!;
    expect([m.diskUsage, m.diskLimit]).toEqual([123, 456]);
    expect(withDisk.find((r) => r.containerIdFull === POSTGRES_ID)!.diskUsage).toBeNull();
  });
});

describe("dockerLabelSource", () => {
  it("lists once per TTL and again when an unknown id shows up", async () => {
    let t = 0;
    const list = vi.fn(async () => [{ id: "a", labels: { x: "1" } }]);
    const source = dockerLabelSource(list, { ttlMs: 60_000, minRefreshMs: 5_000, now: () => t });

    await source(["a"]);
    t = 1_000;
    await source(["a"]);
    expect(list).toHaveBeenCalledTimes(1);

    t = 2_000;
    await source(["a", "b"]);
    expect(list).toHaveBeenCalledTimes(1); // inside minRefresh

    t = 7_000;
    await source(["a", "b"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last list when Docker fails", async () => {
    let t = 0;
    const list = vi.fn().mockResolvedValueOnce([{ id: "a", labels: { x: "1" } }]).mockRejectedValue(new Error("down"));
    const source = dockerLabelSource(list, { ttlMs: 10, now: () => t });
    await source(["a"]);
    t = 100;
    expect((await source(["a"])).get("a")).toEqual({ x: "1" });
  });
});
