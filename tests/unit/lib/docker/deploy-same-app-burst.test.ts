import { describe, it, expect, vi, beforeEach } from "vitest";

// Two deploys of one app environment never run at once, however close together they arrive (#815).

const { store, runs, envRows } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  runs: [] as { opts: { environmentId?: string; signal?: AbortSignal }; finish: () => void }[],
  envRows: new Map<string, { isDefault: boolean }>(),
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
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (_col: unknown, val: unknown) => val,
  and: (...parts: unknown[]) => parts,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      environments: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          const [id] = where as string[];
          return envRows.get(id);
        }),
      },
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
  getConcurrencyLimit: () => 4,
}));

let nextId = 0;
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: vi.fn(async () => `dep-${++nextId}`),
  runDeployment: vi.fn(
    (deploymentId: string, opts: { environmentId?: string; signal?: AbortSignal; onStage?: (s: string, st: string) => Promise<void> }) =>
      new Promise((resolve) => {
        const finish = () =>
          resolve({
            deploymentId,
            success: !opts.signal?.aborted,
            log: "",
            durationMs: 1,
            status: opts.signal?.aborted ? "superseded" : "success",
          });
        if (opts.signal?.aborted) return finish();
        opts.signal?.addEventListener("abort", finish);
        runs.push({ opts, finish });
        void opts.onStage?.("build", "running");
      }),
  ),
}));

import { requestDeploy } from "@/lib/docker/deploy-cancel";

const flush = () => new Promise((r) => setTimeout(r, 10));
const live = () => runs.filter((r) => !r.opts.signal?.aborted);
const deploy = () => requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "webhook" });

beforeEach(() => {
  store.clear();
  runs.length = 0;
  envRows.clear();
});

describe("same-app deploys arriving together", () => {
  it("runs one of two simultaneous deliveries at a time", async () => {
    const first = deploy();
    const second = deploy();
    await flush();
    expect(live()).toHaveLength(1);

    live()[0].finish();
    await flush();
    expect(live()).toHaveLength(1);
    live()[0].finish();
    await Promise.all([first, second]);
  });

  it("keeps a burst of three to one live deploy, the newest", async () => {
    const all = [deploy(), deploy(), deploy()];
    for (let i = 0; i < 5; i++) {
      await flush();
      expect(live().length).toBeLessThanOrEqual(1);
      live()[0]?.finish();
    }
    const results = await Promise.all(all);
    expect(results.filter((r) => r.status === "success")).toHaveLength(1);
    expect(results.at(-1)?.status).toBe("success");
  });

  it("waits for a deploy another process registered first", async () => {
    store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "elsewhere", stage: "deploy" }));
    const pending = deploy();
    await flush();
    expect(runs).toHaveLength(0);

    store.delete("deploy:active:app-1");
    await new Promise((r) => setTimeout(r, 400));
    expect(live()).toHaveLength(1);
    live()[0].finish();
    await pending;
  });
});
