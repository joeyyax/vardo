// Mesh SSH key exchange: what's stored from a peer, when it's resent and what an unlinked peer loses.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeshClientError } from "@/lib/mesh/client";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGI6/QR1fwt33EFMygRHuBK82QAh42lFkI8Qzdfxv3Ts";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK90j9wHyHnIT5iWOwJyQR0rHdrJmQ04c5uM5t7f56qU";

const state = vi.hoisted(() => ({
  peer: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  post: vi.fn(),
  sync: vi.fn(),
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
vi.mock("@/lib/mesh/ssh-endpoint", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/ssh-endpoint")>()),
  meshClientKey: async () => ({ privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: KEY_A }),
  meshSshHostKey: async () => KEY_B,
  syncAuthorizedKeys: state.sync,
}));
vi.mock("@/lib/mesh/builder-exchange", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/builder-exchange")>()),
  localBuilderPayload: async () => ({ builderKey: null, builder: null }),
}));

const NO_BUILDER = { builderKey: null, builder: null };
const BUILDER_PEER = { peerBuilderKey: null, builderCert: null };

const { exchangeSshKeys, localSshKeys, peerSshColumns, resetSshExchange, storePeerSsh } = await import("@/lib/mesh/ssh-exchange");

beforeEach(() => {
  resetSshExchange();
  state.updates.length = 0;
  state.post.mockReset();
  state.sync.mockReset().mockResolvedValue("written");
  state.peer = { id: "p1", name: "Long House", connectionType: "direct", acceptBuilds: false, peerSshKey: null, peerSshHostKey: null, ...BUILDER_PEER };
});

describe("peerSshColumns", () => {
  it("stores valid keys without comments, a port and the opt-in", () => {
    expect(peerSshColumns({ sshKey: `${KEY_A} jy0`, sshHostKey: KEY_B, sshPort: 22, acceptsBuilds: true })).toEqual({
      peerSshKey: KEY_A, peerSshHostKey: KEY_B, peerSshPort: 22, peerAcceptsBuilds: true,
    });
  });

  it("keeps what it has for malformed fields and clears on null", () => {
    expect(peerSshColumns({ sshKey: `command="sh" ${KEY_A}`, sshHostKey: null, sshPort: 70000, acceptsBuilds: "yes" })).toEqual({ peerSshHostKey: null });
    expect(peerSshColumns(null)).toEqual({});
  });
});

describe("localSshKeys", () => {
  it("sends this side's client key, host key, port and whether it runs the peer's builds", async () => {
    expect(await localSshKeys({ id: "p1", acceptBuilds: true, ...BUILDER_PEER })).toEqual({ sshKey: KEY_A, sshHostKey: KEY_B, sshPort: 22, acceptsBuilds: true, ...NO_BUILDER });
  });
});

describe("storePeerSsh", () => {
  it("rewrites authorized_keys when an accepted peer's key changes", async () => {
    await storePeerSsh({ id: "p1", acceptBuilds: true, peerSshKey: KEY_B, ...BUILDER_PEER }, { sshKey: KEY_A });
    expect(state.sync).toHaveBeenCalledTimes(1);
  });

  it("leaves authorized_keys alone for a peer it doesn't run builds for", async () => {
    await storePeerSsh({ id: "p1", acceptBuilds: false, peerSshKey: null, ...BUILDER_PEER }, { sshKey: KEY_A });
    expect(state.updates[0]).toMatchObject({ peerSshKey: KEY_A });
    expect(state.sync).not.toHaveBeenCalled();
  });
});

describe("exchangeSshKeys", () => {
  it("sends over the signed channel and stores the answer", async () => {
    state.post.mockResolvedValue({ data: { sshKey: KEY_B, sshHostKey: KEY_A, sshPort: 22, acceptsBuilds: true }, transport: "tunnel" });
    expect(await exchangeSshKeys("p1")).toBe("sent");
    expect(state.post).toHaveBeenCalledWith("p1", "/api/v1/mesh/ssh-keys", { sshKey: KEY_A, sshHostKey: KEY_B, sshPort: 22, acceptsBuilds: false, ...NO_BUILDER }, expect.anything());
    expect(state.updates[0]).toMatchObject({ peerSshKey: KEY_B, peerSshHostKey: KEY_A, peerAcceptsBuilds: true });
  });

  it("skips a resend when nothing changed, unless forced", async () => {
    state.post.mockResolvedValue({ data: { sshKey: KEY_B, sshHostKey: KEY_A }, transport: "tunnel" });
    await exchangeSshKeys("p1");
    state.peer = { ...state.peer!, peerSshKey: KEY_B, peerSshHostKey: KEY_A };
    expect(await exchangeSshKeys("p1")).toBe("skipped");
    expect(await exchangeSshKeys("p1", { force: true })).toBe("sent");
    expect(state.post).toHaveBeenCalledTimes(2);
  });

  it("treats an older peer without the route as unsupported", async () => {
    state.post.mockRejectedValue(new MeshClientError("Not found", "PEER_ERROR", 404));
    expect(await exchangeSshKeys("p1")).toBe("unsupported");
    expect(state.updates).toEqual([]);
  });

  it("forgets a peer's keys once it no longer knows this instance", async () => {
    state.peer = { ...state.peer!, acceptBuilds: true, peerSshKey: KEY_B, peerSshHostKey: KEY_A };
    state.post.mockRejectedValue(new MeshClientError("No link with the calling instance", "PEER_ERROR", 410));
    expect(await exchangeSshKeys("p1")).toBe("forgotten");
    expect(state.updates[0]).toMatchObject({ peerSshKey: null, peerSshHostKey: null, peerSshPort: null, peerAcceptsBuilds: false, peerBuilderKey: null, peerBuilderPort: null, peerBuilderCa: null, peerBuilderCert: null });
    expect(state.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps the keys through a clock or signature problem", async () => {
    state.post.mockRejectedValue(new MeshClientError("Signature expired; check both instances' clocks", "PEER_ERROR", 401));
    expect(await exchangeSshKeys("p1")).toBe("failed");
    expect(state.updates).toEqual([]);
  });

  it("never trades keys with a peer seen only through a hub", async () => {
    state.peer = { ...state.peer!, connectionType: "visible" };
    expect(await exchangeSshKeys("p1")).toBe("skipped");
    expect(state.post).not.toHaveBeenCalled();
  });
});
