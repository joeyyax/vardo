import { describe, it, expect } from "vitest";
import {
  findStaleBackends,
  findUnroutedContainers,
  decideRestart,
  CONFIRM_STREAK,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
} from "@/lib/docker/traefik-drift";

const NOW = 1_000_000_000;

describe("findStaleBackends", () => {
  const backends = [
    { service: "a@docker", url: "http://172.18.0.5:3000", ip: "172.18.0.5" },
    { service: "b@docker", url: "http://172.18.0.6:3000", ip: "172.18.0.6" },
  ];

  it("returns nothing when every backend IP is live", () => {
    expect(findStaleBackends(backends, new Set(["172.18.0.5", "172.18.0.6"]))).toEqual([]);
  });

  it("returns the backends whose IP no container holds", () => {
    const stale = findStaleBackends(backends, new Set(["172.18.0.5"]));
    expect(stale.map((b) => b.service)).toEqual(["b@docker"]);
  });
});

describe("decideRestart", () => {
  it("waits until the drift has held for the confirm streak", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK - 1, recentRestarts: [], now: NOW })).toBe("wait");
  });

  it("restarts once the streak is confirmed", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [], now: NOW })).toBe("restart");
  });

  it("backs off when Traefik was restarted inside the backoff window", () => {
    const recent = NOW - (RESTART_BACKOFF_MS - 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "backoff",
    );
  });

  it("restarts again once the backoff window has elapsed", () => {
    const recent = NOW - (RESTART_BACKOFF_MS + 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "restart",
    );
  });

  it("gives up after the max restarts in the window", () => {
    // Spread the timestamps past the backoff window so the cap is what stops us.
    const spacing = RESTART_WINDOW_MS / (MAX_RESTARTS_PER_WINDOW + 1);
    const recent = Array.from(
      { length: MAX_RESTARTS_PER_WINDOW },
      (_, i) => NOW - RESTART_WINDOW_MS + spacing * (i + 1),
    );
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: recent, now: NOW })).toBe(
      "giveup",
    );
  });
});

describe("findUnroutedContainers", () => {
  const backend = { service: "a@docker", url: "http://172.18.0.5:3000", ip: "172.18.0.5" };

  function container(over: Partial<{ name: string; labels: Record<string, string>; ips: string[] }> = {}) {
    return {
      name: "vardo-frontend",
      labels: { "traefik.enable": "true" },
      ips: ["172.18.0.5"],
      ...over,
    };
  }

  it("is quiet when the container has a backend", () => {
    expect(findUnroutedContainers([container()], [backend])).toEqual([]);
  });

  it("flags a container that asks for routing and has none", () => {
    // The vardo.yax.me case: up, healthy, labelled, and absent from Traefik.
    expect(findUnroutedContainers([container()], [])).toEqual(["vardo-frontend"]);
  });

  it("ignores containers that never asked to be routed", () => {
    expect(findUnroutedContainers([container({ labels: {} })], [])).toEqual([]);
  });

  it("ignores traefik.enable=false", () => {
    const off = container({ labels: { "traefik.enable": "false" } });
    expect(findUnroutedContainers([off], [])).toEqual([]);
  });

  it("ignores a container with no address yet", () => {
    expect(findUnroutedContainers([container({ ips: [] })], [])).toEqual([]);
  });

  it("matches on any of a multi-homed container's addresses", () => {
    const multi = container({ ips: ["10.1.0.9", "172.18.0.5"] });
    expect(findUnroutedContainers([multi], [backend])).toEqual([]);
  });
});
