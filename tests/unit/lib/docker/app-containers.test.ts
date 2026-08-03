import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ContainerInfo } from "@/lib/docker/client";

const listContainersMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/docker/client", () => ({ listContainers: listContainersMock }));

const { appContainerScope, listAppContainers } = await import("@/lib/docker/app-containers");
type ContainerOwnerApp = Parameters<typeof appContainerScope>[0];

function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c1",
    name: "container",
    image: "img",
    state: "running",
    status: "Up 2 hours",
    ports: [],
    labels: {},
    ...overrides,
  };
}

function app(overrides: Partial<ContainerOwnerApp> = {}): ContainerOwnerApp {
  return {
    id: "app-1",
    name: "paperless",
    status: "active",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    ...overrides,
  };
}

// Every container in a stack carries the parent's vardo labels.
const stackContainers = [
  container({
    id: "c-redis",
    name: "immich-redis-1",
    labels: {
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "com.docker.compose.service": "redis",
    },
  }),
  container({
    id: "c-server",
    name: "immich-server-1",
    labels: {
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "com.docker.compose.service": "server",
    },
  }),
];

const serverChild = app({
  id: "child-server",
  name: "immich-server",
  parentAppId: "parent-immich",
  composeService: "server",
  parentApp: { name: "immich" },
});

beforeEach(() => {
  listContainersMock.mockReset().mockResolvedValue([]);
});

describe("appContainerScope", () => {
  it("uses the app's own id and name for a plain app", () => {
    expect(appContainerScope(app())).toEqual({ id: "app-1", name: "paperless" });
  });

  it("uses the parent's id and name for a stack child", () => {
    expect(appContainerScope(serverChild)).toEqual({ id: "parent-immich", name: "immich" });
  });
});

describe("listAppContainers", () => {
  it("resolves a stack child to its own service's container", async () => {
    listContainersMock.mockResolvedValue(stackContainers);

    const result = await listAppContainers(serverChild);

    expect(listContainersMock).toHaveBeenCalledWith({ id: "parent-immich", name: "immich" });
    expect(result.map((c) => c.id)).toEqual(["c-server"]);
  });

  it("does not give a stack child a sibling's container", async () => {
    listContainersMock.mockResolvedValue(stackContainers);

    const redisChild = app({
      id: "child-redis",
      name: "immich-redis",
      parentAppId: "parent-immich",
      composeService: "redis",
      parentApp: { name: "immich" },
    });

    const result = await listAppContainers(redisChild);

    expect(result.map((c) => c.id)).toEqual(["c-redis"]);
  });

  it("returns nothing when the child's service is not running", async () => {
    listContainersMock.mockResolvedValue(stackContainers);

    const mlChild = app({
      id: "child-ml",
      name: "immich-ml",
      parentAppId: "parent-immich",
      composeService: "machine-learning",
      parentApp: { name: "immich" },
    });

    expect(await listAppContainers(mlChild)).toEqual([]);
  });

  it("gives the parent every service in the stack", async () => {
    listContainersMock.mockResolvedValue(stackContainers);

    const parent = app({ id: "parent-immich", name: "immich" });

    const result = await listAppContainers(parent);

    expect(listContainersMock).toHaveBeenCalledWith({ id: "parent-immich", name: "immich" });
    expect(result.map((c) => c.id)).toEqual(["c-redis", "c-server"]);
  });

  it("leaves a non-decomposed app on its own id and name", async () => {
    listContainersMock.mockResolvedValue([
      container({ id: "c-mine", labels: { "vardo.project.id": "app-1" } }),
    ]);

    const result = await listAppContainers(app());

    expect(listContainersMock).toHaveBeenCalledWith({ id: "app-1", name: "paperless" });
    expect(result.map((c) => c.id)).toEqual(["c-mine"]);
  });
});
