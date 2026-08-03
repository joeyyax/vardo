import { describe, it, expect, beforeEach, vi } from "vitest";

// Loki is tenanted by organization, so the fleet-wide sweep is one pair of
// queries per organization. What matters here is that no query crosses an
// organization and that a failed one leaves its apps unsampled rather than
// recording the zeros a quiet app would produce.

type RunningApp = {
  id: string;
  organizationId: string;
  parentAppId: string | null;
  composeService: string | null;
  containerStartedAt: Date | null;
};

const state = vi.hoisted(() => ({
  running: [] as RunningApp[],
  /** Organizations whose queries throw. */
  failing: new Set<string>(),
  queried: [] as { query: string; organizationId: string }[],
  stored: [] as { appId: string; errors: number; lines: number }[],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging/client", () => ({
  isLokiAvailable: async () => true,
  queryInstant: async (query: string, organizationId: string) => {
    state.queried.push({ query, organizationId });
    if (state.failing.has(organizationId)) throw new Error("tenant unreachable");
    return state.running
      .filter((a) => a.organizationId === organizationId)
      .map((a) => ({ labels: { project_id: a.id }, value: 1 }));
  },
}));

// Two shapes go through select(): the running apps, and the deploy windows the
// elevated cache reads. orderBy marks the second, which has nothing to return.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(state.running), { orderBy: async () => [] }),
      }),
    }),
  },
}));

vi.mock("@/lib/metrics/store-errors", () => ({
  storeLogCounts: async (
    appId: string,
    _at: number,
    counts: { errors: number; lines: number },
  ) => {
    state.stored.push({ appId, ...counts });
  },
  queryLogCounts: async () => [],
}));

vi.mock("@/lib/redis", () => ({
  redis: { set: async () => "OK", get: async () => null },
}));

import { collectErrorRates } from "@/lib/logging/error-rate";

function app(id: string, organizationId: string): RunningApp {
  return { id, organizationId, parentAppId: null, composeService: null, containerStartedAt: null };
}

beforeEach(() => {
  state.running = [app("a1", "org-one"), app("a2", "org-one"), app("b1", "org-two")];
  state.failing = new Set();
  state.queried = [];
  state.stored = [];
});

describe("collectErrorRates", () => {
  it("queries once per organization, never across them", async () => {
    await collectErrorRates();

    const orgs = state.queried.map((q) => q.organizationId);
    expect(orgs.filter((o) => o === "org-one")).toHaveLength(2); // errors and lines
    expect(orgs.filter((o) => o === "org-two")).toHaveLength(2);
    expect(new Set(orgs)).toEqual(new Set(["org-one", "org-two"]));
  });

  it("samples every running app when every organization answers", async () => {
    const sampled = await collectErrorRates();

    expect(sampled).toBe(3);
    expect(state.stored.map((s) => s.appId).sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("leaves a failed organization unsampled rather than recording zeros", async () => {
    state.failing.add("org-one");

    const sampled = await collectErrorRates();

    expect(sampled).toBe(1);
    expect(state.stored.map((s) => s.appId)).toEqual(["b1"]);
  });

  it("stores nothing when no organization answers", async () => {
    state.failing = new Set(["org-one", "org-two"]);

    expect(await collectErrorRates()).toBe(0);
    expect(state.stored).toEqual([]);
  });
});
