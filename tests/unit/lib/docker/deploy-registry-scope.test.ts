import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The deploy registry is keyed per environment.
//
// It was keyed by appId alone, so the pr-24 preview deploy superseded the
// notes-api production merge deploy nine seconds after it started.
// ---------------------------------------------------------------------------

const { store, runs, envRows } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  runs: [] as { opts: { environmentId?: string; signal?: AbortSignal }; finish: () => void }[],
  envRows: new Map<string, { isDefault: boolean }>(),
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
        opts.signal?.addEventListener("abort", finish);
        runs.push({ opts, finish });
        void opts.onStage?.("build", "running");
      }),
  ),
}));

import { requestDeploy } from "@/lib/docker/deploy-cancel";

const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  store.clear();
  runs.length = 0;
  envRows.clear();
  envRows.set("env-prod", { isDefault: true });
  envRows.set("env-pr-ab", { isDefault: false });
});

describe("requestDeploy registry scope", () => {
  it("a preview deploy does not abort a production deploy of the same app", async () => {
    const production = requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "webhook" });
    await flush();
    expect(runs).toHaveLength(1);

    const preview = requestDeploy({
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-pr-ab",
      groupEnvironmentId: "ge-1",
    });
    await flush();

    expect(runs[0].opts.signal?.aborted).toBe(false);
    expect(runs).toHaveLength(2);

    runs[1].finish();
    runs[0].finish();
    await expect(production).resolves.toMatchObject({ status: "success" });
    await expect(preview).resolves.toMatchObject({ status: "success" });
  });

  it("registers a preview deploy under its own key", async () => {
    void requestDeploy({
      appId: "app-1",
      organizationId: "org-1",
      trigger: "webhook",
      environmentId: "env-pr-ab",
    });
    await flush();

    expect(store.has("deploy:active:app-1:env-pr-ab")).toBe(true);
    expect(store.has("deploy:active:app-1")).toBe(false);
    runs[0].finish();
  });

  it("still supersedes a production build with a newer production deploy", async () => {
    void requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "webhook" });
    await flush();
    void requestDeploy({ appId: "app-1", organizationId: "org-1", trigger: "manual", environmentId: "env-prod" });
    await flush();

    expect(runs[0].opts.signal?.aborted).toBe(true);
    runs.at(-1)?.finish();
  });
});
