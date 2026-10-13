import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// clearActiveInRedis — non-default-environment force-cancel
//
// The cancel route force-cancels a running deploy whose process died, then
// clears deploy:active:{scope} so the next deploy can start. The scope is
// `${appId}:${environmentId}` for non-default environments, not bare appId.
// Clearing the wrong key would leave the registry held by the dead owner,
// blocking every future deploy of that environment for up to 30 s (the lease).
// ---------------------------------------------------------------------------

const { store, deploymentRows } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  deploymentRows: new Map<string, { environmentId: string | null }>(),
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
      environments: { findFirst: vi.fn().mockResolvedValue({ isDefault: false }) },
      deployments: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          // The eq mock returns the value directly, so where is the deploymentId string.
          const id = where as string;
          return deploymentRows.get(id) ?? null;
        }),
      },
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import { clearActiveInRedis } from "@/lib/docker/deploy-cancel";

beforeEach(() => {
  store.clear();
  deploymentRows.clear();
});

describe("clearActiveInRedis — non-default environment", () => {
  it("clears the per-environment key the dead deploy owns, not the default-env key", async () => {
    deploymentRows.set("dep-stuck", { environmentId: "env-pr-ab" });
    store.set("deploy:active:app-1:env-pr-ab", JSON.stringify({ deploymentId: "dep-stuck", stage: "deploy" }));

    await clearActiveInRedis("app-1", "dep-stuck");

    expect(store.has("deploy:active:app-1:env-pr-ab")).toBe(false);
  });

  it("leaves an unrelated environment's key alone", async () => {
    deploymentRows.set("dep-stuck", { environmentId: "env-pr-ab" });
    store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "dep-other", stage: "deploy" }));
    store.set("deploy:active:app-1:env-pr-ab", JSON.stringify({ deploymentId: "dep-stuck", stage: "deploy" }));

    await clearActiveInRedis("app-1", "dep-stuck");

    expect(store.has("deploy:active:app-1")).toBe(true);
    expect(store.has("deploy:active:app-1:env-pr-ab")).toBe(false);
  });

  it("is a no-op when the dead process no longer owns the key", async () => {
    deploymentRows.set("dep-stuck", { environmentId: "env-pr-ab" });
    store.set("deploy:active:app-1:env-pr-ab", JSON.stringify({ deploymentId: "dep-newer", stage: "deploy" }));

    await clearActiveInRedis("app-1", "dep-stuck");

    expect(JSON.parse(store.get("deploy:active:app-1:env-pr-ab")!)).toMatchObject({ deploymentId: "dep-newer" });
  });

  it("falls back to the default-environment scope for synthetic owner IDs that aren't a row", async () => {
    store.set("deploy:active:app-1", JSON.stringify({ deploymentId: "instant-rollback:123:abc", stage: "routing" }));

    await clearActiveInRedis("app-1", "instant-rollback:123:abc");

    expect(store.has("deploy:active:app-1")).toBe(false);
  });
});