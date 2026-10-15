import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rollout, RolloutMember } from "@/lib/self-update/rollout-plan";

const T = "b".repeat(40);
const OLD = "a".repeat(40);
const NEWER = "c".repeat(40);
const NEXT = "d".repeat(40);

const h = vi.hoisted(() => ({
  rollout: null as unknown,
  peers: [] as { id: string; instanceId: string }[],
  shaByPeer: {} as Record<string, string>,
  failRetry: new Set<string>(),
  retried: [] as string[],
  channelTarget: null as string | null,
  compare: {} as Record<string, "ahead" | "behind" | "identical" | "diverged" | null>,
  actions: [] as string[],
  incidentsClosed: 0,
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      meshPeers: {
        findFirst: async ({ where }: { where: string }) => h.peers.find((peer) => peer.instanceId === where),
        findMany: async () => h.peers.map((peer) => ({ ...peer, connectionType: "direct", type: "persistent", vardoUpdate: null })),
      },
    },
  },
}));
vi.mock("@/lib/db/schema", () => ({ meshPeers: { instanceId: "instanceId", internalIp: "internalIp" } }));
vi.mock("drizzle-orm", () => ({ eq: (_column: unknown, value: unknown) => value }));
vi.mock("@/lib/constants", () => ({ getInstanceId: async () => "hub" }));
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => ({ instanceName: "hub" }) }));
vi.mock("@/lib/mesh/ip-allocator", () => ({ HUB_IP: "10.0.0.1" }));
vi.mock("@/lib/redis-lock", () => ({ acquireLock: async () => "lock", releaseLock: async () => {} }));
vi.mock("@/lib/mesh/client", () => ({
  meshSignedPost: async (peerId: string, _path: string, body: { action: string }) => {
    if (body.action === "retry") {
      if (h.failRetry.has(peerId)) throw new Error("timed out");
      h.retried.push(peerId);
    }
    return { data: { state: "blocked", sha: h.shaByPeer[peerId], reason: "failed", deploymentId: null } };
  },
}));
vi.mock("@/lib/version", () => ({
  getBuildSha: () => OLD,
  getChannelUpdate: async () => (h.channelTarget ? { targetSha: h.channelTarget, targetLabel: "next" } : null),
  fetchCompare: async (base: string) => {
    const status = h.compare[base];
    return status ? { status } : null;
  },
}));
vi.mock("@/lib/self-update/rollout-capability", () => ({
  localRolloutCapability: async () => ({ mode: "off" }),
  parseRolloutCapability: () => ({ mode: "auto", channel: "main", priority: "standard" }),
}));
vi.mock("@/lib/self-update/rollout-peer", () => ({ readPeerReadiness: vi.fn(), startPeerRollout: vi.fn(), retryPeerRollout: vi.fn() }));
vi.mock("@/lib/self-update/store", () => ({
  getRollout: async () => h.rollout,
  setRollout: async (rollout: unknown) => { h.rollout = structuredClone(rollout); },
}));
vi.mock("@/lib/self-update/rollout-events", () => ({
  announceRollout: async () => {},
  recordMemberChanges: async () => {},
  recordRolloutAction: async (_rollout: unknown, action: string) => { h.actions.push(action); },
  closeRolloutIncident: async () => { h.incidentsClosed++; },
}));

const { actOnRollout, tickRollout, unlinkedMemberIds, RolloutActionError } = await import("@/lib/self-update/coordinator");

function member(instanceId: string, state: RolloutMember["state"]): RolloutMember {
  return { instanceId, name: instanceId, priority: "standard", state, fromSha: OLD, reason: state === "failed" ? "failed" : null, busySince: null, notifiedBusyAt: null, deploymentId: null };
}

function paused(members: RolloutMember[]): Rollout {
  return { id: "r1", targetSha: T, targetLabel: "v1", channel: "main", startedAt: "2026-10-14T00:00:00Z", finishedAt: null, state: "paused", immediate: false, pendingSha: null, notices: [], members };
}

const stored = () => h.rollout as Rollout;

beforeEach(() => {
  h.rollout = null;
  h.peers = [{ id: "p-jy0", instanceId: "jy0" }];
  h.shaByPeer = { "p-jy0": OLD, "p-prod": OLD };
  h.failRetry = new Set();
  h.retried = [];
  h.channelTarget = T;
  h.compare = {};
  h.actions = [];
  h.incidentsClosed = 0;
});

describe("paused rollout on the next tick", () => {
  it("is superseded once the failed member runs a commit past the target", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.shaByPeer["p-jy0"] = NEWER;
    h.compare[NEWER] = "behind";
    await tickRollout();
    expect(stored().state).toBe("superseded");
    expect(stored().finishedAt).not.toBeNull();
    expect(h.actions).toContain("system.rollout_superseded");
    expect(h.incidentsClosed).toBe(1);
  });

  it("is superseded when the failed member runs exactly the target", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.shaByPeer["p-jy0"] = T;
    await tickRollout();
    expect(stored().state).toBe("superseded");
  });

  it("stays paused while a failed member is still behind the target", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.compare[OLD] = "ahead";
    await tickRollout();
    expect(stored().state).toBe("paused");
  });

  it("stays paused when the member's version can't be compared", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.shaByPeer["p-jy0"] = NEWER;
    await tickRollout();
    expect(stored().state).toBe("paused");
  });

  it("is superseded when the channel has a newer target", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.channelTarget = NEXT;
    await tickRollout();
    expect(stored().state).toBe("superseded");
  });
});

describe("retry", () => {
  it("never retries a member that already runs past the target", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    h.shaByPeer["p-jy0"] = NEWER;
    h.compare[NEWER] = "behind";
    const result = await actOnRollout("retry", "r1", "u1");
    expect(result.state).toBe("superseded");
    expect(h.retried).toEqual([]);
  });

  it("skips the member past the target and retries the one still behind", async () => {
    h.peers = [{ id: "p-jy0", instanceId: "jy0" }, { id: "p-prod", instanceId: "prod" }];
    h.shaByPeer = { "p-jy0": NEWER, "p-prod": OLD };
    h.compare = { [NEWER]: "behind", [OLD]: "ahead" };
    h.rollout = paused([member("jy0", "failed"), member("prod", "failed")]);
    const result = await actOnRollout("retry", "r1", "u1");
    expect(h.retried).toEqual(["p-prod"]);
    expect(result.state).toBe("running");
    expect(result.members.find((item) => item.instanceId === "jy0")?.state).toBe("skipped");
    expect(result.members.find((item) => item.instanceId === "prod")?.state).toBe("waiting");
  });

  it("leaves an unreachable member for the next pass instead of aborting", async () => {
    h.peers = [{ id: "p-jy0", instanceId: "jy0" }, { id: "p-prod", instanceId: "prod" }];
    h.compare = { [OLD]: "ahead" };
    h.failRetry = new Set(["p-jy0"]);
    h.rollout = paused([member("jy0", "failed"), member("prod", "failed")]);
    const result = await actOnRollout("retry", "r1", "u1");
    expect(h.retried).toEqual(["p-prod"]);
    expect(result.state).toBe("running");
    const jy0 = result.members.find((item) => item.instanceId === "jy0");
    expect(jy0?.state).toBe("unreachable");
    expect(jy0?.reason).toBe("timed out");
    expect(result.members.find((item) => item.instanceId === "prod")?.state).toBe("waiting");
  });
});

describe("skip and dismiss", () => {
  it("removes a failed member that is no longer linked and resumes", async () => {
    h.peers = [];
    h.rollout = paused([member("prod-2", "failed")]);
    expect(await unlinkedMemberIds(stored())).toEqual(["prod-2"]);
    const result = await actOnRollout("skip", "r1", "u1", "prod-2");
    expect(result.members[0].state).toBe("skipped");
    expect(result.state).toBe("running");
  });

  it("refuses to skip a failed member that is still linked", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    await expect(actOnRollout("skip", "r1", "u1", "jy0")).rejects.toBeInstanceOf(RolloutActionError);
  });

  it("dismisses a paused rollout and closes its incident", async () => {
    h.rollout = paused([member("jy0", "failed")]);
    const result = await actOnRollout("dismiss", "r1", "u1");
    expect(result.state).toBe("superseded");
    expect(h.actions).toEqual(["system.rollout_dismissed"]);
    expect(h.incidentsClosed).toBe(1);
  });

  it("refuses to dismiss a rollout that isn't paused", async () => {
    h.rollout = { ...paused([member("jy0", "waiting")]), state: "running" };
    await expect(actOnRollout("dismiss", "r1", "u1")).rejects.toBeInstanceOf(RolloutActionError);
  });
});
