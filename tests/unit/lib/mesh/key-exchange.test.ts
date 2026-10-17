// Mesh key exchange: what's stored from a peer, when it's resent and what an unlinked peer loses.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeshClientError } from "@/lib/mesh/client";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGI6/QR1fwt33EFMygRHuBK82QAh42lFkI8Qzdfxv3Ts";

const state = vi.hoisted(() => ({
  peer: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  post: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { meshPeers: { findFirst: async () => state.peer } },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void state.updates.push(v) }) }),
  },
}));
vi.mock("@/lib/mesh/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/client")>()),
  meshSignedPost: state.post,
}));
vi.mock("@/lib/mesh/builder-exchange", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/builder-exchange")>()),
  localBuilderPayload: async () => ({ builderKey: null, builder: null }),
}));

const NO_BUILDER = { builderKey: null, builder: null };
const NO_SSH = { sshKey: null, sshHostKey: null, sshPort: null };
const BUILDER_PEER = { peerBuilderKey: null, builderCert: null };

const { exchangeKeys, localKeys, peerKeyColumns, resetKeyExchange } = await import("@/lib/mesh/key-exchange");

beforeEach(() => {
  resetKeyExchange();
  state.updates.length = 0;
  state.post.mockReset();
  state.peer = { id: "p1", name: "Long House", connectionType: "direct", acceptBuilds: false, ...BUILDER_PEER };
});

describe("peerKeyColumns", () => {
  it("stores the opt-in and ignores an older peer's SSH keys", () => {
    expect(peerKeyColumns({ sshKey: KEY_A, sshHostKey: KEY_A, sshPort: 22, acceptsBuilds: true })).toEqual({ peerAcceptsBuilds: true });
  });

  it("keeps what it has for malformed fields", () => {
    expect(peerKeyColumns({ acceptsBuilds: "yes" })).toEqual({});
    expect(peerKeyColumns(null)).toEqual({});
  });
});

describe("localKeys", () => {
  it("sends whether it runs the peer's builds, and nulls that clear an older peer's SSH keys", async () => {
    expect(await localKeys({ id: "p1", acceptBuilds: true, ...BUILDER_PEER })).toEqual({ ...NO_SSH, acceptsBuilds: true, ...NO_BUILDER });
  });
});

describe("exchangeKeys", () => {
  it("sends over the signed channel and stores the answer", async () => {
    state.post.mockResolvedValue({ data: { sshKey: KEY_A, acceptsBuilds: true }, transport: "tunnel" });
    expect(await exchangeKeys("p1")).toBe("sent");
    expect(state.post).toHaveBeenCalledWith("p1", "/api/v1/mesh/ssh-keys", { ...NO_SSH, acceptsBuilds: false, ...NO_BUILDER }, expect.anything());
    expect(state.updates[0]).toEqual({ peerAcceptsBuilds: true, updatedAt: expect.any(Date) });
  });

  it("skips a resend when nothing changed, unless forced", async () => {
    state.post.mockResolvedValue({ data: { acceptsBuilds: true }, transport: "tunnel" });
    await exchangeKeys("p1");
    state.peer = { ...state.peer!, peerBuilderKey: "known" };
    expect(await exchangeKeys("p1")).toBe("skipped");
    expect(await exchangeKeys("p1", { force: true })).toBe("sent");
    expect(state.post).toHaveBeenCalledTimes(2);
  });

  it("treats a peer without the route as unsupported", async () => {
    state.post.mockRejectedValue(new MeshClientError("Not found", "PEER_ERROR", 404));
    expect(await exchangeKeys("p1")).toBe("unsupported");
    expect(state.updates).toEqual([]);
  });

  it("forgets a peer's builder once it no longer knows this instance", async () => {
    state.peer = { ...state.peer!, acceptBuilds: true };
    state.post.mockRejectedValue(new MeshClientError("No link with the calling instance", "PEER_ERROR", 410));
    expect(await exchangeKeys("p1")).toBe("forgotten");
    expect(state.updates[0]).toMatchObject({ peerAcceptsBuilds: false, peerBuilderKey: null, peerBuilderPort: null, peerBuilderCa: null, peerBuilderCert: null });
  });

  it("keeps the keys through a clock or signature problem", async () => {
    state.post.mockRejectedValue(new MeshClientError("Signature expired; check both instances' clocks", "PEER_ERROR", 401));
    expect(await exchangeKeys("p1")).toBe("failed");
    expect(state.updates).toEqual([]);
  });

  it("never trades keys with a peer seen only through a hub", async () => {
    state.peer = { ...state.peer!, connectionType: "visible" };
    expect(await exchangeKeys("p1")).toBe("skipped");
    expect(state.post).not.toHaveBeenCalled();
  });
});
