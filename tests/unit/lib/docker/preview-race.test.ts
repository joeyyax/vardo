import { describe, it, expect, beforeEach, vi } from "vitest";

// tools-api#25 was opened and closed five seconds apart. The close ran
// while the create was still cloning, found nothing, and the create then
// finished and left an orphaned preview running.

const { store, live, gate, deployGroupMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const live = new Map<string, { id: string; name: string }>();
  let open: () => void = () => {};
  const gate = {
    wait: () => new Promise<void>((r) => (open = r)),
    release: () => open(),
    entered: false,
  };
  return { store, live, gate, deployGroupMock: vi.fn() };
});

vi.mock("@/lib/redis", () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
    eval: async (script: string, _n: number, key: string, token: string) => {
      if (store.get(key) !== token) return 0;
      if (script.includes('"del"')) store.delete(key);
      return 1;
    },
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findMany: vi.fn(async () => [
          {
            id: "svc",
            name: "tools-api",
            gitUrl: "https://github.com/joeyyax/tools-api.git",
            projectId: "proj",
            organizationId: "org-1",
            parentAppId: null,
            dependsOn: null,
            cloneStrategy: "clone",
          },
        ]),
      },
      groupEnvironments: { findFirst: vi.fn(async () => [...live.values()][0] ?? null) },
    },
  },
}));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/docker/deploy-group", () => ({ deployGroup: deployGroupMock }));
vi.mock("@/lib/docker/clone", () => ({
  createGroupEnvironment: vi.fn(async (opts: { name: string }) => {
    gate.entered = true;
    await gate.wait();
    live.set("ge-1", { id: "ge-1", name: opts.name });
    return {
      groupEnvironmentId: "ge-1",
      projectEnvironments: [{ appId: "svc", appName: "tools-api", environmentId: "env-1", domain: "s-pr-25.example.com" }],
    };
  }),
  destroyGroupEnvironment: vi.fn(async (id: string) => {
    live.delete(id);
    return { removed: ["tools-api"] };
  }),
}));

import { createPreview, destroyPreview } from "@/lib/docker/preview";

const REPO = "joeyyax/tools-api";
const tick = () => new Promise((r) => setTimeout(r, 20));
const open = () =>
  createPreview({ repoFullName: REPO, prNumber: 25, prUrl: "https://github.com/x/pull/25", branch: "feat" });

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
}

beforeEach(() => {
  store.clear();
  live.clear();
  gate.entered = false;
  deployGroupMock.mockReset().mockResolvedValue({ success: true, results: [], totalDurationMs: 0 });
});

describe("open and close a PR within seconds", () => {
  it("leaves no preview behind when the close lands mid-create", async () => {
    const opening = open();
    await until(() => gate.entered);

    const closing = destroyPreview(REPO, 25);
    await tick();
    gate.release();

    await Promise.all([opening, closing]);
    expect(live.size).toBe(0);
  }, 10_000);

  it("never deploys a preview that was closed before its deploy started", async () => {
    const opening = open();
    await until(() => gate.entered);
    const closing = destroyPreview(REPO, 25);
    await tick();
    gate.release();
    await Promise.all([opening, closing]);

    expect(deployGroupMock).not.toHaveBeenCalled();
  }, 10_000);

  it("keeps the preview when the PR is reopened after the close", async () => {
    const opening = open();
    await until(() => gate.entered);
    const closing = destroyPreview(REPO, 25);
    await tick();
    gate.release();
    await Promise.all([opening, closing]);

    gate.entered = false;
    const reopening = open();
    await until(() => gate.entered);
    gate.release();
    await reopening;

    expect(live.size).toBe(1);
  }, 10_000);
});
