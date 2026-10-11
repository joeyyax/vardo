// The mesh directory reports an unreachable peer as "unreachable" and never throws.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { meshDirectory, CACHE_TTL_MS } = await import("@/lib/instances/mesh-directory");
const { MeshClientError } = await import("@/lib/mesh/client");

type Peer = { id: string; name: string; status: string; peerAcceptsInstanceBrowse: boolean; peerAcceptsInstanceSignin: boolean };

const PEERS: Record<string, Peer> = {
  up: { id: "up", name: "edge", status: "online", peerAcceptsInstanceBrowse: true, peerAcceptsInstanceSignin: true },
  down: { id: "down", name: "lab", status: "online", peerAcceptsInstanceBrowse: true, peerAcceptsInstanceSignin: false },
  offline: { id: "offline", name: "cold", status: "offline", peerAcceptsInstanceBrowse: true, peerAcceptsInstanceSignin: true },
  closed: { id: "closed", name: "shut", status: "online", peerAcceptsInstanceBrowse: false, peerAcceptsInstanceSignin: true },
};

function directory(post: ReturnType<typeof vi.fn>, clock = { t: 0 }) {
  return meshDirectory({
    post: post as never,
    findPeer: async (id) => PEERS[id] ?? null,
    listPeers: async () => Object.values(PEERS),
    now: () => clock.t,
  });
}

const ORGS = { organizations: [{ id: "o1", name: "Alpha", role: "owner" }] };

describe("meshDirectory", () => {
  it("returns a reachable peer's orgs and an unreachable one's state side by side", async () => {
    const post = vi.fn(async (peerId: string) => {
      if (peerId === "down") throw new MeshClientError('Lost the connection to "lab"', "UNREACHABLE");
      return { data: ORGS };
    });
    const dir = directory(post);
    const [up, down] = await Promise.all([dir.organizations("up", "owner@example.com"), dir.organizations("down", "owner@example.com")]);
    expect(up).toEqual({ state: "ok", data: ORGS.organizations });
    expect(down).toEqual({ state: "unreachable" });
  });

  it("treats a 5xx and a malformed answer as unreachable", async () => {
    const dir = directory(vi.fn(async () => {
      throw new MeshClientError("Peer returned 502", "PEER_ERROR", 502);
    }));
    expect(await dir.organizations("up", "owner@example.com")).toEqual({ state: "unreachable" });

    const garbled = directory(vi.fn(async () => ({ data: { organizations: "nope" } })));
    expect(await garbled.organizations("up", "owner@example.com")).toEqual({ state: "unreachable" });
  });

  it("passes on a peer's refusal", async () => {
    const dir = directory(vi.fn(async () => {
      throw new MeshClientError("No user with that verified email on edge.", "PEER_ERROR", 403);
    }));
    expect(await dir.projects("up", "owner@example.com", "o1")).toEqual({
      state: "refused",
      reason: "No user with that verified email on edge.",
    });
  });

  it("doesn't call a peer the heartbeat marks offline", async () => {
    const post = vi.fn();
    expect(await directory(post).organizations("offline", "owner@example.com")).toEqual({ state: "unreachable" });
    expect(post).not.toHaveBeenCalled();
  });

  it("doesn't call a peer that hasn't opted in", async () => {
    const post = vi.fn();
    const res = await directory(post).organizations("closed", "owner@example.com");
    expect(res.state).toBe("refused");
    expect(post).not.toHaveBeenCalled();
  });

  it("caches an answer for under 30 seconds", async () => {
    expect(CACHE_TTL_MS).toBeLessThanOrEqual(30_000);
    const clock = { t: 0 };
    const post = vi.fn(async () => ({ data: ORGS }));
    const dir = directory(post, clock);
    await dir.organizations("up", "owner@example.com");
    clock.t = CACHE_TTL_MS - 1;
    await dir.organizations("up", "owner@example.com");
    expect(post).toHaveBeenCalledTimes(1);
    clock.t = CACHE_TTL_MS + 1;
    await dir.organizations("up", "owner@example.com");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by user", async () => {
    const post = vi.fn(async () => ({ data: ORGS }));
    const dir = directory(post);
    await dir.organizations("up", "a@example.com");
    await dir.organizations("up", "b@example.com");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("lists opted-in peers with their status", async () => {
    const list = await directory(vi.fn()).instances();
    expect(list.find((p) => p.id === "offline")).toMatchObject({ status: "offline", signIn: true, browse: true });
    expect(list.find((p) => p.id === "down")).toMatchObject({ signIn: false, browse: true });
  });
});
