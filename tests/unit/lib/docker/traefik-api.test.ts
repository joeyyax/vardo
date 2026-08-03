import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ContainerInfo } from "@/lib/docker/client";

const dockerRequestMock = vi.hoisted(() => vi.fn());
const listAllContainersMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/docker/client", () => ({
  dockerRequest: dockerRequestMock,
  listAllContainers: listAllContainersMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const {
  backendIp,
  collectDockerBackends,
  fetchTraefikRouters,
  fetchTraefikServices,
  findTraefikContainer,
  ipsOf,
  liveContainers,
} = await import("@/lib/docker/traefik-api");

function service(overrides: Record<string, unknown> = {}) {
  return {
    name: "app@docker",
    provider: "docker",
    status: "enabled",
    loadBalancer: { servers: [{ url: "http://172.18.0.5:3000" }] },
    ...overrides,
  };
}

function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c1",
    name: "vardo-traefik",
    image: "traefik:v3.2",
    state: "running",
    status: "Up 2 hours",
    ports: [],
    labels: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.TRAEFIK_API_URL;
  delete process.env.VARDO_TRAEFIK_CONTAINER;
});

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

describe("fetchTraefikServices", () => {
  it("reads the services collection from the default API URL", async () => {
    mockFetch.mockResolvedValue(jsonResponse([service()]));
    await expect(fetchTraefikServices()).resolves.toEqual([service()]);
    expect(mockFetch.mock.calls[0][0]).toBe("http://vardo-traefik:8080/api/http/services");
  });

  it("honors TRAEFIK_API_URL", async () => {
    process.env.TRAEFIK_API_URL = "http://localhost:9999";
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchTraefikServices();
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:9999/api/http/services");
  });

  it("requests uncached", async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    await fetchTraefikServices();
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("returns null on a non-OK response", async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, false, 502));
    await expect(fetchTraefikServices()).resolves.toBeNull();
  });

  it("returns null when Traefik is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchTraefikServices()).resolves.toBeNull();
  });
});

describe("fetchTraefikRouters", () => {
  it("reads the routers collection", async () => {
    const routers = [{ name: "app@docker", status: "enabled", provider: "docker" }];
    mockFetch.mockResolvedValue(jsonResponse(routers));
    await expect(fetchTraefikRouters()).resolves.toEqual(routers);
    expect(mockFetch.mock.calls[0][0]).toBe("http://vardo-traefik:8080/api/http/routers");
  });

  it("returns null when Traefik is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchTraefikRouters()).resolves.toBeNull();
  });
});

describe("liveContainers", () => {
  it("lists only running containers", async () => {
    dockerRequestMock.mockResolvedValue([]);
    await liveContainers();
    const path = dockerRequestMock.mock.calls[0][1] as string;
    expect(decodeURIComponent(path)).toBe('/containers/json?filters={"status":["running"]}');
  });

  it("collects every address across networks", async () => {
    dockerRequestMock.mockResolvedValue([
      {
        Names: ["/vardo-frontend"],
        Labels: { "traefik.enable": "true" },
        NetworkSettings: {
          Networks: {
            bridge: { IPAddress: "172.18.0.5" },
            mesh: { IPAddress: "10.1.0.9", GlobalIPv6Address: "fd00::1" },
          },
        },
      },
    ]);
    await expect(liveContainers()).resolves.toEqual([
      {
        name: "vardo-frontend",
        labels: { "traefik.enable": "true" },
        ips: ["172.18.0.5", "10.1.0.9", "fd00::1"],
      },
    ]);
  });

  it("tolerates a container with no name, labels or networks", async () => {
    dockerRequestMock.mockResolvedValue([{}]);
    await expect(liveContainers()).resolves.toEqual([{ name: "?", labels: {}, ips: [] }]);
  });
});

describe("ipsOf", () => {
  it("flattens and dedupes addresses", () => {
    const containers = [
      { name: "a", labels: {}, ips: ["172.18.0.5", "10.1.0.9"] },
      { name: "b", labels: {}, ips: ["172.18.0.5"] },
    ];
    expect([...ipsOf(containers)]).toEqual(["172.18.0.5", "10.1.0.9"]);
  });
});

describe("findTraefikContainer", () => {
  it("finds the running container by image", async () => {
    listAllContainersMock.mockResolvedValue([
      container({ id: "other", name: "postgres", image: "postgres:17" }),
      container(),
    ]);
    await expect(findTraefikContainer()).resolves.toEqual({ id: "c1", name: "vardo-traefik" });
  });

  it("matches a registry-qualified image", async () => {
    listAllContainersMock.mockResolvedValue([container({ image: "docker.io/library/traefik:v3" })]);
    await expect(findTraefikContainer()).resolves.toEqual({ id: "c1", name: "vardo-traefik" });
  });

  it("ignores images that merely start with traefik", async () => {
    listAllContainersMock.mockResolvedValue([container({ image: "traefikee:v2" })]);
    await expect(findTraefikContainer()).resolves.toBeNull();
  });

  it("ignores containers that are not running", async () => {
    listAllContainersMock.mockResolvedValue([container({ state: "exited" })]);
    await expect(findTraefikContainer()).resolves.toBeNull();
  });

  it("matches the configured name instead of the image", async () => {
    process.env.VARDO_TRAEFIK_CONTAINER = "edge";
    listAllContainersMock.mockResolvedValue([
      container(),
      container({ id: "c2", name: "edge", image: "custom/proxy:1" }),
    ]);
    await expect(findTraefikContainer()).resolves.toEqual({ id: "c2", name: "edge" });
  });

  it("returns null when the configured name is not running", async () => {
    process.env.VARDO_TRAEFIK_CONTAINER = "edge";
    listAllContainersMock.mockResolvedValue([container()]);
    await expect(findTraefikContainer()).resolves.toBeNull();
  });
});
