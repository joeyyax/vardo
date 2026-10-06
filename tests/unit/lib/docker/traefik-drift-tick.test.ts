import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const restartContainer = vi.fn();
const fetchTraefikServices = vi.fn();
const liveContainers = vi.fn();
const emit = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { organizations: { findMany: async () => [{ id: "org1" }] } } },
}));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: (...a: unknown[]) => emit(...a) }));
vi.mock("@/lib/docker/client", () => ({
  restartContainer: (...a: unknown[]) => restartContainer(...a),
}));
vi.mock("@/lib/docker/traefik-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docker/traefik-api")>()),
  fetchTraefikServices: () => fetchTraefikServices(),
  liveContainers: () => liveContainers(),
  findTraefikContainer: async () => ({ id: "traefik-id", name: "vardo-traefik" }),
}));

import {
  tickTraefikDrift,
  resetDriftState,
  RESTART_BACKOFF_MS,
} from "@/lib/docker/traefik-drift";

const ROUTED = {
  "traefik.enable": "true",
  "traefik.http.routers.app.rule": "Host(`app.example.com`)",
};

const routedService = {
  name: "other@docker",
  provider: "docker",
  status: "enabled",
  loadBalancer: { servers: [{ url: "http://172.18.0.2:80" }] },
};

let now = 1_000_000_000;

async function tickFor(ms: number, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    now += ms;
    await tickTraefikDrift();
  }
}

beforeEach(() => {
  resetDriftState();
  restartContainer.mockReset();
  emit.mockReset();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetchTraefikServices.mockResolvedValue([routedService]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tickTraefikDrift", () => {
  it("never restarts over an enabled sidecar with no router", async () => {
    liveContainers.mockResolvedValue([
      { name: "other", labels: ROUTED, ips: ["172.18.0.2"] },
      { name: "sockpuppetbrowser-1", labels: { "traefik.enable": "true" }, ips: ["172.18.0.9"] },
    ]);
    await tickFor(60_000, 120);
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it("restarts once for an unrouted container, then alerts and stops", async () => {
    liveContainers.mockResolvedValue([
      { name: "other", labels: ROUTED, ips: ["172.18.0.2"] },
      { name: "app-1", labels: ROUTED, ips: ["172.18.0.9"] },
    ]);
    // Three hours of the same mismatch, well past backoff and the hourly cap.
    await tickFor(60_000, 180);

    expect(restartContainer).toHaveBeenCalledTimes(1);
    const titles = emit.mock.calls.map((c) => (c[1] as { title: string }).title);
    expect(titles).toEqual(["Traefik restarted to clear stale routes", "Traefik routing is stale"]);
  });

  it("restarts for a new fault after an earlier one survived", async () => {
    liveContainers.mockResolvedValue([
      { name: "other", labels: ROUTED, ips: ["172.18.0.2"] },
      { name: "app-1", labels: ROUTED, ips: ["172.18.0.9"] },
    ]);
    await tickFor(60_000, 15);
    expect(restartContainer).toHaveBeenCalledTimes(1);

    liveContainers.mockResolvedValue([
      { name: "other", labels: ROUTED, ips: ["172.18.0.2"] },
      { name: "app-1", labels: ROUTED, ips: ["172.18.0.9"] },
      { name: "app-2", labels: ROUTED, ips: ["172.18.0.10"] },
    ]);
    await tickFor(RESTART_BACKOFF_MS, 2);
    expect(restartContainer).toHaveBeenCalledTimes(2);
  });

  it("restarts again for a fault that cleared and came back", async () => {
    const broken = [
      { name: "other", labels: ROUTED, ips: ["172.18.0.2"] },
      { name: "app-1", labels: ROUTED, ips: ["172.18.0.9"] },
    ];
    liveContainers.mockResolvedValue(broken);
    await tickFor(60_000, 2);
    expect(restartContainer).toHaveBeenCalledTimes(1);

    liveContainers.mockResolvedValue([broken[0]]);
    await tickFor(60_000, 1);

    liveContainers.mockResolvedValue(broken);
    await tickFor(RESTART_BACKOFF_MS, 2);
    expect(restartContainer).toHaveBeenCalledTimes(2);
  });
});
