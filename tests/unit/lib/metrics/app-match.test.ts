import { describe, it, expect } from "vitest";

import {
  matchAppMetrics,
  groupMetricsByApp,
  dedupeMetrics,
  filterByEnvironment,
  type MetricsApp,
} from "@/lib/metrics/app-match";
import { aggregateContainers } from "@/lib/metrics/aggregate";
import type { ContainerMetrics } from "@/lib/metrics/types";

function metric(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  return {
    containerId: "abc123abc123",
    containerIdFull: "abc123abc123",
    containerName: "container",
    projectName: "immich",
    organizationId: "org-1",
    labels: {},
    cpuPercent: 0,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    diskUsage: 0,
    diskLimit: 0,
    diskWriteBytes: 0,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
    timestamp: 1,
    ...overrides,
  };
}

function app(overrides: Partial<MetricsApp> = {}): MetricsApp {
  return {
    id: "app-1",
    name: "paperless",
    status: "active",
    organizationId: "org-1",
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    ...overrides,
  };
}

// Every container in the stack carries the parent's vardo labels; only
// com.docker.compose.service tells the services apart.
const stack = [
  metric({
    containerId: "c-redis",
    containerName: "immich-redis-1",
    memoryUsage: 40_000_000,
    labels: {
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "vardo.environment": "production",
      "com.docker.compose.project": "immich",
      "com.docker.compose.service": "redis",
    },
  }),
  metric({
    containerId: "c-server",
    containerName: "immich-immich-server-1",
    memoryUsage: 552_000_000,
    labels: {
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "vardo.environment": "production",
      "com.docker.compose.project": "immich",
      "com.docker.compose.service": "immich-server",
    },
  }),
];

const parent = app({ id: "parent-immich", name: "immich" });

const serverChild = app({
  id: "child-server",
  name: "immich-immich-server",
  parentAppId: "parent-immich",
  composeService: "immich-server",
});

const redisChild = app({
  id: "child-redis",
  name: "immich-redis",
  parentAppId: "parent-immich",
  composeService: "redis",
});

describe("matchAppMetrics", () => {
  it("resolves a stack child to its own service", () => {
    const matched = matchAppMetrics(serverChild, stack);

    expect(matched.map((m) => m.containerId)).toEqual(["c-server"]);
    expect(aggregateContainers(matched).memory).toBe(552_000_000);
  });

  it("does not give a stack child a sibling's memory", () => {
    const matched = matchAppMetrics(redisChild, stack);

    expect(matched.map((m) => m.containerId)).toEqual(["c-redis"]);
    expect(aggregateContainers(matched).memory).toBe(40_000_000);
  });

  it("gives the parent the whole stack", () => {
    const matched = matchAppMetrics(parent, stack);

    expect(matched.map((m) => m.containerId)).toEqual(["c-redis", "c-server"]);
    expect(aggregateContainers(matched).memory).toBe(592_000_000);
  });

  it("returns nothing when the child's service is not running", () => {
    const mlChild = app({
      id: "child-ml",
      name: "immich-machine-learning",
      parentAppId: "parent-immich",
      composeService: "machine-learning",
    });

    expect(matchAppMetrics(mlChild, stack)).toEqual([]);
  });

  it("leaves a non-decomposed app on its own project id", () => {
    const own = metric({
      containerId: "c-mine",
      projectName: "paperless",
      memoryUsage: 100,
      labels: { "vardo.project": "paperless", "vardo.project.id": "app-1" },
    });

    expect(matchAppMetrics(app(), [...stack, own]).map((m) => m.containerId)).toEqual(["c-mine"]);
  });

  it("does not sweep in a differently-named app that shares its prefix", () => {
    const neighbor = metric({
      containerId: "c-neighbor",
      projectName: "paperless-ngx",
      labels: { "vardo.project": "paperless-ngx", "vardo.project.id": "app-2" },
    });

    expect(matchAppMetrics(app(), [neighbor])).toEqual([]);
  });

  it("ignores another organization's container of the same name", () => {
    const foreign = metric({
      containerId: "c-foreign",
      containerName: "paperless",
      projectName: "paperless",
      organizationId: "org-2",
      labels: { "vardo.project": "paperless" },
    });

    expect(matchAppMetrics(app(), [foreign])).toEqual([]);
  });

  it("still matches an unlabeled container by name", () => {
    const imported = metric({
      containerId: "c-imported",
      containerName: "paperless",
      projectName: "paperless",
      organizationId: null,
      labels: {},
    });

    expect(matchAppMetrics(app(), [imported]).map((m) => m.containerId)).toEqual(["c-imported"]);
  });

  it("matches an imported app by its full container id", () => {
    const full = "a".repeat(64);
    const imported = metric({
      containerId: full.slice(0, 12),
      containerIdFull: full,
      containerName: "some-other-name",
      projectName: "unrelated",
      labels: {},
    });

    const importedApp = app({ importedContainerId: full });

    expect(matchAppMetrics(importedApp, [imported]).map((m) => m.containerId)).toEqual([
      full.slice(0, 12),
    ]);
  });

  it("strips the env and slot suffix off a compose-only project", () => {
    const slotted = metric({
      containerId: "c-slot",
      projectName: "paperless-production-green",
      labels: { "com.docker.compose.project": "paperless-production-green" },
    });

    expect(matchAppMetrics(app(), [slotted]).map((m) => m.containerId)).toEqual(["c-slot"]);
  });
});

describe("groupMetricsByApp", () => {
  it("gives the parent and each child their own view of the stack", () => {
    const grouped = groupMetricsByApp([parent, serverChild, redisChild], stack);

    expect(grouped.get("parent-immich")?.map((m) => m.containerId)).toEqual(["c-redis", "c-server"]);
    expect(grouped.get("child-server")?.map((m) => m.containerId)).toEqual(["c-server"]);
    expect(grouped.get("child-redis")?.map((m) => m.containerId)).toEqual(["c-redis"]);
  });
});

describe("dedupeMetrics", () => {
  it("counts a stack once when the parent and its children all match it", () => {
    const grouped = groupMetricsByApp([parent, serverChild, redisChild], stack);
    const total = dedupeMetrics(grouped.values());

    expect(total).toHaveLength(2);
    expect(aggregateContainers(total).memory).toBe(592_000_000);
  });
});

describe("filterByEnvironment", () => {
  it("keeps only containers labeled with that environment", () => {
    const staging = metric({
      containerId: "c-staging",
      labels: { "vardo.project.id": "parent-immich", "vardo.environment": "staging" },
    });

    const kept = filterByEnvironment([...stack, staging], "production");

    expect(kept.map((m) => m.containerId)).toEqual(["c-redis", "c-server"]);
  });

  it("reads a shared container's environment off its compose project name", () => {
    const kept = filterByEnvironment([sharedDb("shop-production-shared"), sharedDb("shop-pr-7-shared")], "production");

    expect(kept.map((m) => m.labels["com.docker.compose.project"])).toEqual([
      "shop-production-shared",
    ]);
  });

  it("keeps a shared container whose project is pinned by the compose name", () => {
    const kept = filterByEnvironment([sharedDb("vardo")], "production");

    expect(kept).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// x-vardo-shared services
//
// Brought up with --no-recreate, so they carry no vardo labels at all — only
// what compose writes. Their sibling slot containers are labeled as usual.
// ---------------------------------------------------------------------------

function sharedDb(project: string): ContainerMetrics {
  return metric({
    containerId: `c-${project}-db`,
    containerName: `${project}-postgres-1`,
    projectName: project,
    organizationId: null,
    memoryUsage: 90_000_000,
    labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.service": "postgres",
    },
  });
}

const slottedWeb = metric({
  containerId: "c-web",
  containerName: "shop-production-green-web-1",
  projectName: "shop",
  memoryUsage: 10_000_000,
  labels: {
    "vardo.project": "shop",
    "vardo.project.id": "parent-shop",
    "vardo.environment": "production",
    "com.docker.compose.project": "shop-production-green",
    "com.docker.compose.service": "web",
  },
});

const shopParent = app({ id: "parent-shop", name: "shop" });

describe("shared services", () => {
  it("gives the parent its shared container alongside the labeled slot", () => {
    const matched = matchAppMetrics(shopParent, [slottedWeb, sharedDb("shop-production-shared")]);

    expect(matched.map((m) => m.containerId)).toEqual(["c-web", "c-shop-production-shared-db"]);
    expect(aggregateContainers(matched).memory).toBe(100_000_000);
  });

  it("finds it under a project name pinned by the compose file", () => {
    const pinned = metric({
      containerId: "c-vardo-db",
      containerName: "vardo-postgres",
      projectName: "vardo",
      organizationId: null,
      labels: {
        "com.docker.compose.project": "vardo",
        "com.docker.compose.service": "postgres",
      },
    });
    const frontend = metric({
      containerId: "c-vardo-frontend",
      containerName: "vardo-production-green-frontend-1",
      labels: {
        "vardo.project.id": "parent-vardo",
        "vardo.environment": "production",
        "com.docker.compose.project": "vardo-production-green",
        "com.docker.compose.service": "frontend",
      },
    });

    const matched = matchAppMetrics(app({ id: "parent-vardo", name: "vardo" }), [frontend, pinned]);

    expect(matched.map((m) => m.containerId)).toEqual(["c-vardo-frontend", "c-vardo-db"]);
  });

  it("resolves the decomposed child to its own shared container", () => {
    const dbChild = app({
      id: "child-db",
      name: "shop-postgres",
      parentAppId: "parent-shop",
      composeService: "postgres",
    });

    const matched = matchAppMetrics(dbChild, [slottedWeb, sharedDb("shop-production-shared")]);

    expect(matched.map((m) => m.containerId)).toEqual(["c-shop-production-shared-db"]);
  });

  it("does not hand it to a differently-named app", () => {
    const other = app({ id: "parent-shopify", name: "shopify" });

    expect(matchAppMetrics(other, [sharedDb("shop-production-shared")])).toEqual([]);
  });

  it("counts it once when the parent and the child both match it", () => {
    const dbChild = app({
      id: "child-db",
      name: "shop-postgres",
      parentAppId: "parent-shop",
      composeService: "postgres",
    });
    const metrics = [slottedWeb, sharedDb("shop-production-shared")];
    const total = dedupeMetrics(groupMetricsByApp([shopParent, dbChild], metrics).values());

    expect(total).toHaveLength(2);
    expect(aggregateContainers(total).memory).toBe(100_000_000);
  });

  it("keeps a preview's shared database off the production view", () => {
    const matched = matchAppMetrics(shopParent, [
      slottedWeb,
      sharedDb("shop-production-shared"),
      sharedDb("shop-pr-7-shared"),
    ]);

    expect(filterByEnvironment(matched, "production").map((m) => m.containerId)).toEqual([
      "c-web",
      "c-shop-production-shared-db",
    ]);
  });
});
