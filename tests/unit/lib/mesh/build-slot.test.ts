// A slot in a linked instance's build gate, against a fake peer: claim, renew, release, a full peer and an older one.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/mesh/client", async () => {
  class MeshClientError extends Error {
    constructor(message: string, public code: string, public statusCode?: number) {
      super(message);
    }
  }
  return { MeshClientError, meshSignedPost: vi.fn() };
});

const { MeshClientError } = await import("@/lib/mesh/client");
const { BUILD_SLOT_PATH, claimPeerSlot, peerBuilderStats, releasePeerSlot, renewPeerSlot, resetPeerSlots } = await import("@/lib/mesh/build-slot");

/** A peer gate with `limit` slots and leases that lapse when `lapse` is called. */
function fakePeer(limit = 1) {
  const held = new Set<string>();
  const calls: { path: string; action: string; token: string }[] = [];
  const post = vi.fn(async (_peer: string, path: string, payload: unknown) => {
    const { action, token } = payload as { action: string; token: string };
    calls.push({ path, action, token });
    if (action === "claim") {
      if (held.size >= limit) return { data: { held: false } };
      held.add(token);
      return { data: { held: true } };
    }
    if (action === "renew") return { data: { held: held.has(token) } };
    held.delete(token);
    return { data: { held: false } };
  });
  return { post, held, calls, lapse: (token: string) => held.delete(token) };
}

beforeEach(() => {
  resetPeerSlots();
});

describe("peer build slots", () => {
  it("claims, renews and releases a slot on the peer", async () => {
    const peer = fakePeer();
    expect(await claimPeerSlot("lh", "dep-a-x1", peer.post)).toBe("granted");
    expect(peer.held.has("dep-a-x1")).toBe(true);
    expect(await renewPeerSlot("lh", "dep-a-x1", peer.post)).toBe(true);
    await releasePeerSlot("lh", "dep-a-x1", peer.post);
    expect(peer.held.size).toBe(0);
    expect(peer.calls.map((c) => [c.path, c.action])).toEqual([
      [BUILD_SLOT_PATH, "claim"],
      [BUILD_SLOT_PATH, "renew"],
      [BUILD_SLOT_PATH, "release"],
    ]);
  });

  it("says the peer is full when its gate refuses", async () => {
    const peer = fakePeer(1);
    expect(await claimPeerSlot("lh", "own-build", peer.post)).toBe("granted");
    expect(await claimPeerSlot("lh", "dep-b-x2", peer.post)).toBe("full");
    expect(peer.held.has("dep-b-x2")).toBe(false);
  });

  it("reports a lease the peer let lapse, and an unanswered renew as unknown", async () => {
    const peer = fakePeer();
    await claimPeerSlot("lh", "dep-a-x1", peer.post);
    peer.lapse("dep-a-x1");
    expect(await renewPeerSlot("lh", "dep-a-x1", peer.post)).toBe(false);
    const down = vi.fn(async () => { throw new MeshClientError("Lost the connection", "UNREACHABLE"); });
    expect(await renewPeerSlot("lh", "dep-a-x1", down)).toBeNull();
  });

  it("treats an older peer without the endpoint as before and doesn't ask it again for a while", async () => {
    const old = vi.fn(async () => { throw new MeshClientError("Peer returned 404", "PEER_ERROR", 404); });
    expect(await claimPeerSlot("old", "dep-a-x1", old)).toBe("unsupported");
    expect(await claimPeerSlot("old", "dep-b-x2", old)).toBe("unsupported");
    expect(old).toHaveBeenCalledTimes(1);
  });

  it("builds without a slot when the peer doesn't answer, and asks again next time", async () => {
    const down = vi.fn(async () => { throw new MeshClientError("Peer returned 503", "PEER_ERROR", 503); });
    expect(await claimPeerSlot("lh", "dep-a-x1", down)).toBe("unreachable");
    expect(await claimPeerSlot("lh", "dep-a-x1", down)).toBe("unreachable");
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("reads the peer's isolated builder's OOM kills and limit", async () => {
    const post = vi.fn(async () => ({ data: { builder: { oomKills: 3, limitBytes: 4 * 1024 ** 3 } } }));
    expect(await peerBuilderStats("lh", "dep-a-x1", post)).toEqual({ oomKills: 3, limitBytes: 4 * 1024 ** 3 });
    expect(post).toHaveBeenCalledWith("lh", BUILD_SLOT_PATH, { action: "builder", token: "dep-a-x1" }, { timeoutMs: 10_000 });
  });

  it("keeps only counts it can trust from the reply", async () => {
    const post = vi.fn(async () => ({ data: { builder: { oomKills: "3", limitBytes: -1 } } }));
    expect(await peerBuilderStats("lh", "dep-a-x1", post)).toEqual({ oomKills: null, limitBytes: null });
  });

  it("has nothing from a peer that predates the action or doesn't answer", async () => {
    const old = vi.fn(async () => { throw new MeshClientError("Peer returned 400", "PEER_ERROR", 400); });
    expect(await peerBuilderStats("old", "dep-a-x1", old)).toBeNull();
    expect(await peerBuilderStats("lh", "dep-a-x1", vi.fn(async () => ({ data: { held: false } })))).toBeNull();
  });

  it("never throws on release", async () => {
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    await expect(releasePeerSlot("lh", "dep-a-x1", down)).resolves.toBeUndefined();
  });
});
