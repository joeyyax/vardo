import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// A Vardo self-deploy ends by stopping the slot running it, which kills every
// deploy in that process. The stop waits for them, and no new one starts.
// An instant rollback never runs under a deploy of the same app.
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async set(key: string, value: string, ..._rest: unknown[]) {
        if (_rest.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async del(key: string) {
        store.delete(key);
      },
    },
    dbWrites: [] as Record<string, unknown>[],
  };
});

vi.mock("@/lib/redis", () => ({ redis: fake.redis }));
vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        fake.dbWrites.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: vi.fn(),
  runDeployment: vi.fn(),
}));
vi.mock("@/lib/docker/deploy-concurrency", () => ({
  enqueueAndTryAcquire: vi.fn().mockResolvedValue(true),
  waitForConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  removeFromQueue: vi.fn(),
  getConcurrencyLimit: () => 2,
}));

import {
  requestDeploy,
  drainForSelfStop,
  claimAppForOperation,
  resetDrainForTests,
} from "@/lib/docker/deploy-cancel";
import { runDeployment } from "@/lib/docker/deploy";
import { DeployBlockedError } from "@/lib/docker/errors";

type Held = { signal?: AbortSignal; finish: () => void };

/** Start a deploy whose run stays open until `finish` is called. */
function startDeploy(appId: string, deploymentId: string): { held: Promise<Held>; done: Promise<unknown> } {
  let resolveHeld!: (h: Held) => void;
  const held = new Promise<Held>((r) => (resolveHeld = r));
  vi.mocked(runDeployment).mockImplementationOnce(
    (id, opts) =>
      new Promise((resolve) => {
        resolveHeld({
          signal: opts.signal,
          finish: () =>
            resolve({ deploymentId: id, success: true, log: "", durationMs: 0, status: "success" }),
        });
      }),
  );
  const done = requestDeploy({ appId, organizationId: "org-1", trigger: "api", deploymentId });
  return { held, done };
}

const OPS = { appId: "other-app" };

describe("drainForSelfStop", () => {
  beforeEach(() => {
    resetDrainForTests();
    fake.store.clear();
    fake.dbWrites.length = 0;
    vi.mocked(runDeployment).mockReset();
  });

  it("waits for another app's deploy to finish before letting the stop run", async () => {
    const { held, done } = startDeploy(OPS.appId, "dep-other");
    const other = await held;

    let drained = false;
    const drain = drainForSelfStop("vardo-app", () => {}).then((cut) => {
      drained = true;
      return cut;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    expect(other.signal?.aborted).toBe(false);

    other.finish();
    await done;
    expect(await drain).toEqual([]);
  });

  it("gives up at the deadline and names the deploys the stop will cut off", async () => {
    const { held } = startDeploy(OPS.appId, "dep-stuck");
    await held;

    expect(await drainForSelfStop("vardo-app", () => {}, 30)).toEqual(["dep-stuck"]);
  });

  it("does not wait on the self-deploy itself", async () => {
    const { held } = startDeploy("vardo-app", "dep-self");
    await held;

    expect(await drainForSelfStop("vardo-app", () => {}, 1000)).toEqual([]);
  });

  it("refuses a new deploy once draining, without superseding the one running", async () => {
    const { held } = startDeploy(OPS.appId, "dep-running");
    const running = await held;
    void drainForSelfStop("vardo-app", () => {}, 50);

    await expect(
      requestDeploy({ appId: OPS.appId, organizationId: "org-1", trigger: "api", deploymentId: "dep-new" }),
    ).rejects.toBeInstanceOf(DeployBlockedError);
    expect(running.signal?.aborted).toBe(false);
    expect(fake.dbWrites.at(-1)).toMatchObject({ status: "cancelled" });
  });
});

describe("claimAppForOperation", () => {
  beforeEach(() => {
    resetDrainForTests();
    fake.store.clear();
    vi.mocked(runDeployment).mockReset();
  });

  it("refuses while a deploy of the app runs in this process", async () => {
    const { held } = startDeploy("app-1", "dep-1");
    await held;

    expect(await claimAppForOperation("app-1", "instant-rollback", 1000)).toBeNull();
  });

  it("refuses while another process holds the app", async () => {
    fake.store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "dep-x", stage: "build" }));

    expect(await claimAppForOperation("app-1", "instant-rollback", 1000)).toBeNull();
  });

  it("holds the app as a swap-stage owner until released", async () => {
    const claim = await claimAppForOperation("app-1", "instant-rollback", 1000);

    expect(claim).not.toBeNull();
    expect(JSON.parse(fake.store.get("deploy:active:app-1")!)).toMatchObject({ stage: "routing" });

    await claim!.release();
    expect(fake.store.has("deploy:active:app-1")).toBe(false);
  });
});
