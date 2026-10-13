import { describe, it, expect, vi, beforeEach } from "vitest";

// A waiting deploy tells its GitHub feedback where it stands in line.

const { store, places, finished, concurrency } = vi.hoisted(() => ({
  finished: [] as unknown[],
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
  trackDeploy: () => ({ queued: (place: unknown) => places.push(place), stage: vi.fn(), finish: (r: unknown) => finished.push(r) }),
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn(async () => concurrency.immediate),
  waitForConcurrencySlot: vi.fn(async (_id: string, _signal: AbortSignal, onPosition?: (ahead: number) => void) => {
    for (const p of concurrency.waitPlaces) onPosition?.(p);
  }),
  releaseConcurrencySlot: vi.fn(),
  removeFromQueue: vi.fn(async () => {}),
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
  finished.length = 0;
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

describe("a deploy that threw before it ran", () => {
  it("hands the tracker the real reason for a queue timeout", async () => {
    const { waitForConcurrencySlot } = await import("@/lib/docker/deploy-concurrency");
    concurrency.immediate = false;
    vi.mocked(waitForConcurrencySlot).mockRejectedValueOnce(new Error("Deploy queue timeout — waited too long for a concurrency slot"));
    await expect(deploy()).rejects.toThrow("Deploy queue timeout");
    expect(finished).toEqual([{ status: "cancelled", error: "Deploy queue timeout — waited too long for a concurrency slot" }]);
  });

  it("reports a deploy a newer one superseded in the queue as superseded", async () => {
    const { enqueueAndTryAcquire, waitForConcurrencySlot } = await import("@/lib/docker/deploy-concurrency");
    vi.mocked(enqueueAndTryAcquire).mockResolvedValueOnce(false);
    vi.mocked(waitForConcurrencySlot).mockImplementationOnce(
      (_id: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("Deploy cancelled while waiting in concurrency queue"))),
        ),
    );
    const first = deploy();
    await new Promise((r) => setTimeout(r, 20));
    const second = deploy();
    await expect(first).rejects.toThrow("cancelled while waiting");
    await second;
    expect(finished[0]).toEqual({ status: "superseded" });
  });
});

describe("thrownOutcome", () => {
  it("keeps a user's cancel a plain cancel and carries every other reason", async () => {
    const { thrownOutcome } = await import("@/lib/docker/deploy-cancel");
    const { DeployQueueAbortedError } = await import("@/lib/docker/errors");
    expect(thrownOutcome(new DeployQueueAbortedError("x", "killed"))).toEqual({ status: "cancelled" });
    expect(thrownOutcome(new DeployQueueAbortedError("x", "superseded"))).toEqual({ status: "superseded" });
    expect(thrownOutcome(new Error("Vardo is restarting to finish an update — retry the deploy in a minute")))
      .toEqual({ status: "cancelled", error: "Vardo is restarting to finish an update — retry the deploy in a minute" });
  });
});

describe("a deploy closed while it waited", () => {
  it("frees its slot and app lock and hands the tracker nothing to post", async () => {
    const { runDeployment } = await import("@/lib/docker/deploy");
    const { releaseConcurrencySlot } = await import("@/lib/docker/deploy-concurrency");
    vi.mocked(runDeployment).mockResolvedValueOnce({
      deploymentId: "dep-1", success: false, log: "", durationMs: 0, status: "cancelled", closedElsewhere: true,
    });
    await deploy();
    expect(releaseConcurrencySlot).toHaveBeenCalledWith("dep-1");
    expect(store.has("deploy:active:app-1")).toBe(false);
    expect(finished).toEqual([expect.objectContaining({ closedElsewhere: true })]);
  });
});
