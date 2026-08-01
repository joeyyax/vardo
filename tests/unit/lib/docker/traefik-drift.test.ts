import { describe, it, expect } from "vitest";
import {
  backendIp,
  collectDockerBackends,
  findStaleBackends,
  decideRestart,
  CONFIRM_STREAK,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
} from "@/lib/docker/traefik-drift";

const NOW = 1_000_000_000;

function service(overrides: Record<string, unknown> = {}) {
  return {
    name: "app@docker",
    provider: "docker",
    status: "enabled",
    loadBalancer: { servers: [{ url: "http://172.18.0.5:3000" }] },
    ...overrides,
  };
}

describe("backendIp", () => {
  it("returns the IPv4 host", () => {
    expect(backendIp("http://172.18.0.5:3000")).toBe("172.18.0.5");
  });

  it("unwraps a bracketed IPv6 host", () => {
    expect(backendIp("http://[fd00::1]:8080")).toBe("fd00::1");
  });

  it("returns null for a hostname backend", () => {
    expect(backendIp("http://paperless:8000")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(backendIp("not a url")).toBeNull();
  });
});

describe("collectDockerBackends", () => {
  it("collects every server of an enabled Docker service", () => {
    const svc = service({
      loadBalancer: {
        servers: [{ url: "http://172.18.0.5:9000" }, { url: "http://172.18.0.6:9000" }],
      },
    });
    expect(collectDockerBackends([svc]).map((b) => b.ip)).toEqual(["172.18.0.5", "172.18.0.6"]);
  });

  it("skips services from other providers", () => {
    expect(collectDockerBackends([service({ provider: "file" })])).toEqual([]);
  });

  it("skips disabled services", () => {
    expect(collectDockerBackends([service({ status: "disabled" })])).toEqual([]);
  });

  it("skips hostname backends, which resolve at request time", () => {
    const svc = service({ loadBalancer: { servers: [{ url: "http://paperless:8000" }] } });
    expect(collectDockerBackends([svc])).toEqual([]);
  });

  it("tolerates a service with no load balancer", () => {
    expect(collectDockerBackends([service({ loadBalancer: undefined })])).toEqual([]);
  });
});

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
