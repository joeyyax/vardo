// Fan-out reaches every accepting peer at once with a per-peer timeout; one slow peer doesn't hold up the rest.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  targets: [] as { id: string; name: string }[],
  updates: [] as { values: Record<string, unknown> }[],
  findManyArgs: null as unknown,
}));
const { meshSignedPost, recordActivity } = vi.hoisted(() => ({ meshSignedPost: vi.fn(), recordActivity: vi.fn() }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/mesh/client", () => ({ meshSignedPost }));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      meshPeers: {
        findMany: async (args: unknown) => {
          state.findManyArgs = args;
          return state.targets;
        },
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updates.push({ values });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const { fanOutRelay, RELAY_TIMEOUT_MS } = await import("@/lib/mesh/webhook-relay-send");
const { PgDialect } = await import("drizzle-orm/pg-core");

const relay = {
  v: 1 as const,
  relayed: true as const,
  deliveryId: "d-1",
  event: "push" as const,
  repoFullName: "acme/site",
  cloneUrls: { https: "https://github.com/acme/site.git", ssh: "git@github.com:acme/site.git" },
  ref: "refs/heads/main",
  branch: "main",
  headSha: null,
};

beforeEach(() => {
  state.targets = [
    { id: "p1", name: "edge-1" },
    { id: "p2", name: "public-2" },
    { id: "p3", name: "offline" },
  ];
  state.updates.length = 0;
  meshSignedPost.mockReset();
  recordActivity.mockReset();
  recordActivity.mockResolvedValue(undefined);
});

describe("fanOutRelay", () => {
  it("only targets directly linked peers that accept relays", async () => {
    await fanOutRelay(relay);
    const { where } = state.findManyArgs as { where: import("drizzle-orm").SQL };
    const { sql, params } = new PgDialect().sqlToQuery(where);
    expect(sql).toContain('"connection_type"');
    expect(sql).toContain('"peer_accepts_webhook_relay"');
    expect(params).toEqual(["direct", true]);
  });

  it("starts every peer before any finishes and passes a per-peer timeout", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    meshSignedPost.mockImplementation(async (peerId: string) => {
      started.push(peerId);
      if (peerId === "p3") throw new Error("unreachable");
      await gate;
      return { data: { ok: true, accepted: ["site"] }, transport: "tunnel" };
    });

    const done = fanOutRelay(relay, ["org-a"]);
    await vi.waitFor(() => expect(started).toEqual(["p1", "p2", "p3"]));
    release();
    const outcomes = await done;

    for (const call of meshSignedPost.mock.calls) {
      expect(call[1]).toBe("/api/v1/mesh/webhook-relay");
      expect(call[3]).toMatchObject({ timeoutMs: RELAY_TIMEOUT_MS });
    }
    expect(outcomes.map((o) => [o.name, o.ok])).toEqual([
      ["edge-1", true],
      ["public-2", true],
      ["offline", false],
    ]);
  });

  it("records the last relay per peer and an activity per org", async () => {
    meshSignedPost.mockImplementation(async (peerId: string) => {
      if (peerId === "p3") throw new Error("timed out");
      return { data: { ok: true, skipped: "no matching apps" }, transport: "public" };
    });

    await fanOutRelay(relay, ["org-a"]);

    const statuses = state.updates.map((u) => u.values.lastRelaySentStatus);
    expect(statuses).toEqual(["no matching apps", "no matching apps", "failed: timed out"]);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a", action: "mesh.webhook_relay_failed", metadata: expect.objectContaining({ trigger: "offline" }) }),
    );
    expect(recordActivity).toHaveBeenCalledTimes(3);
  });

  it("does nothing without targets", async () => {
    state.targets = [];
    expect(await fanOutRelay(relay)).toEqual([]);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });
});
