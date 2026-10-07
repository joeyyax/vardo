import { describe, it, expect, vi, beforeEach } from "vitest";

// A queued deploy waiting on another deploy of its app holds a worker lease; the sweeper reads its absence as orphaned (#883).

const { store, runs } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  runs: [] as { finish: () => void }[],
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    },
    del: async (k: string) => {
      store.delete(k);
    },
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn().mockResolvedValue(undefined) },
      deployments: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    update: vi.fn(() => ({ set: () => ({ where: () => ({ catch: () => {} }) }) })),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn().mockResolvedValue(true),
  waitForConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  removeFromQueue: vi.fn(),
  getConcurrencyLimit: () => 2,
}));
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: vi.fn(async () => "dep-new"),
  runDeployment: vi.fn(
    (deploymentId: string) =>
      new Promise((resolve) => {
        runs.push({
          finish: () => resolve({ deploymentId, success: true, log: "", durationMs: 1, status: "success" }),
        });
      }),
  ),
}));

import { requestDeploy, deployWorker } from "@/lib/docker/deploy-cancel";

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  store.clear();
  runs.length = 0;
});

describe("deploy worker lease", () => {
  it("is live while a deploy waits behind another deploy of its app", async () => {
    store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "dep-running", stage: "routing" }));

    const pending = requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "api" });
    await flush();

    expect(await deployWorker("dep-new")).toBe("live");
    expect(runs).toHaveLength(0);

    store.delete("deploy:active:app-1");
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(await deployWorker("dep-new")).toBe("live");

    runs[0].finish();
    await pending;

    expect(await deployWorker("dep-new")).toBe("gone");
  });

  it("is gone for a deploy no process picked up", async () => {
    expect(await deployWorker("dep-orphan")).toBe("gone");
  });
});
