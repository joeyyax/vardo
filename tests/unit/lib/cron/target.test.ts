import { describe, it, expect } from "vitest";

import { cronContainerScope, selectCronContainer, type CronTargetApp } from "@/lib/cron/engine";
import type { ContainerInfo } from "@/lib/docker/client";

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

function app(overrides: Partial<CronTargetApp> = {}): CronTargetApp {
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

// A stack's containers all carry the parent's vardo.project label.
const stackChild = app({
  id: "child-server",
  name: "immich-server",
  parentAppId: "parent-immich",
  composeService: "server",
  parentApp: { name: "immich" },
});

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

describe("cronContainerScope", () => {
  it("uses the app's own id and name for a plain app", () => {
    expect(cronContainerScope(app())).toEqual({ id: "app-1", name: "paperless" });
  });

  it("uses the parent's id and name for a stack child", () => {
    expect(cronContainerScope(stackChild)).toEqual({ id: "parent-immich", name: "immich" });
  });
});

describe("selectCronContainer", () => {
  it("picks the container for the child's own compose service", () => {
    // Redis is listed first — matching by app id alone would exec into it.
    expect(selectCronContainer(stackChild, stackContainers)?.id).toBe("c-server");
  });

  it("picks a plain app's own container", () => {
    const containers = [
      container({ id: "c-other", name: "other", labels: { "vardo.project.id": "app-2" } }),
      container({ id: "c-mine", name: "paperless", labels: { "vardo.project.id": "app-1" } }),
    ];
    expect(selectCronContainer(app(), containers)?.id).toBe("c-mine");
  });

  it("skips a matching container that is not running", () => {
    const stopped = stackContainers.map((c) =>
      c.id === "c-server" ? { ...c, state: "exited" } : c,
    );
    expect(selectCronContainer(stackChild, stopped)).toBeNull();
  });

  it("returns null when the stack has no container for that service", () => {
    const child = app({
      id: "child-ml",
      name: "immich-ml",
      parentAppId: "parent-immich",
      composeService: "machine-learning",
      parentApp: { name: "immich" },
    });
    expect(selectCronContainer(child, stackContainers)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(selectCronContainer(app(), [])).toBeNull();
  });
});
