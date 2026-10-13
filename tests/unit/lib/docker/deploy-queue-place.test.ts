import { describe, it, expect, vi, beforeEach } from "vitest";

// A waiting deploy tells its GitHub feedback where it stands in line.

const { store, places, concurrency } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  places: [] as unknown[],
  concurrency: {
    immediate: true,
    waitPlaces: [] as number[],
  },
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: string[]) => {
      if (args.includes("NX") && store.has(k)) return null;
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
vi.mock("@/lib/git-integration/github-feedback", () => ({
  trackDeploy: () => ({ queued: (place: unknown) => places.push(place), stage: vi.fn(), finish: vi.fn() }),
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn(async () => concurrency.immediate),
  waitForConcurrencySlot: vi.fn(async (_id: string, _signal: AbortSignal, onPosition?: (ahead: number) => void) => {
    for (const p of concurrency.waitPlaces) onPosition?.(p);
  }),
  releaseConcurrencySlot: vi.fn(),
  removeFromQueue: vi.fn(),
  getConcurrencyLimit: () => 1,
}));
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: vi.fn(async () => "dep-1"),
  runDeployment: vi.fn(async (deploymentId: string) => ({ deploymentId, success: true, log: "", durationMs: 1, status: "success" })),
}));

import { requestDeploy } from "@/lib/docker/deploy-cancel";

const deploy = () => requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "webhook" });

beforeEach(() => {
  store.clear();
  places.length = 0;
  concurrency.immediate = true;
  concurrency.waitPlaces = [];
});

describe("queue place on GitHub", () => {
  it("forwards each place the system queue reports", async () => {
    concurrency.immediate = false;
    concurrency.waitPlaces = [2, 1, 0];
    await deploy();
    expect(places).toEqual([2, 1, 0]);
  });

  it("reports waiting behind the app's own deploy before the system queue", async () => {
    store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "elsewhere", stage: "deploy" }));
    const pending = deploy();
    await new Promise((r) => setTimeout(r, 20));
    expect(places).toEqual(["app"]);
    store.delete("deploy:active:app-1");
    await pending;
  });

  it("reports nothing for a deploy that starts straight away", async () => {
    await deploy();
    expect(places).toEqual([]);
  });
});
