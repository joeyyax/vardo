import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchAllContainerMetrics } from "@/lib/metrics/cadvisor";

const ID = "00ebd1bf8075d6dd1da83a4a6625a334beeb0dab1a62ca738db8997b35be6aa5";
const KEY = `/system.slice/docker-${ID}.scope`;

function stats() {
  return {
    [KEY]: [
      {
        timestamp: "2026-01-01T00:00:00Z",
        has_cpu: true,
        cpu: { usage: { total: 0 } },
        has_memory: true,
        memory: { usage: 0, working_set: 0 },
        has_network: false,
        has_filesystem: false,
        has_diskio: false,
      },
      {
        timestamp: "2026-01-01T00:00:05Z",
        has_cpu: true,
        cpu: { usage: { total: 5_000_000_000 } },
        has_memory: true,
        memory: { usage: 600_000_000, working_set: 552_000_000 },
        has_network: false,
        has_filesystem: false,
        has_diskio: false,
      },
    ],
  };
}

function spec(labels: Record<string, string>) {
  return { [KEY]: { aliases: ["immich-immich-server-1"], labels, memory: { limit: 0 } } };
}

function mockCadvisor(labels: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("/spec") ? spec(labels) : stats()),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllContainerMetrics — identity", () => {
  it("carries the labels app matching joins on", async () => {
    mockCadvisor({
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "vardo.environment": "production",
      "com.docker.compose.project": "immich",
      "com.docker.compose.service": "immich-server",
    });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/labels");

    expect(m.projectName).toBe("immich");
    expect(m.labels["vardo.project.id"]).toBe("parent-immich");
    expect(m.labels["com.docker.compose.service"]).toBe("immich-server");
    expect(m.memoryUsage).toBe(552_000_000);
  });

  it("drops labels app matching never reads", async () => {
    mockCadvisor({
      "vardo.project": "immich",
      "traefik.http.routers.immich.rule": "Host(`photos.example.com`)",
      "org.opencontainers.image.source": "https://github.com/immich-app/immich",
    });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/pruned");

    expect(Object.keys(m.labels)).toEqual(["vardo.project"]);
  });

  it("reports both the short and full container id", async () => {
    mockCadvisor({ "vardo.project": "immich" });

    const [m] = await fetchAllContainerMetrics("http://cadvisor.test/ids");

    expect(m.containerId).toBe(ID.slice(0, 12));
    expect(m.containerIdFull).toBe(ID);
  });
});
