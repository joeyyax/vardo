import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { query: { meshPeers: { findFirst: mockFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({
  meshPeers: { tokenHash: "tokenHash" },
}));

import { requireMeshPeer, hashMeshToken, isPeerTokenExpired, DEV_PEER_MAX_IDLE_MS } from "@/lib/mesh/auth";

const NOW = new Date("2026-01-31T00:00:00Z");

function peer(overrides: Record<string, unknown> = {}) {
  return {
    id: "peer-1",
    type: "persistent",
    connectionType: "direct",
    tokenHash: hashMeshToken("raw-token"),
    lastSeenAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function request(token = "raw-token") {
  return new NextRequest("http://localhost/api/v1/mesh/heartbeat", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(peer());
});

describe("requireMeshPeer", () => {
  it("returns the peer for a matching token", async () => {
    await expect(requireMeshPeer(request())).resolves.toMatchObject({ id: "peer-1" });
  });

  it("rejects a missing or malformed authorization header", async () => {
    const bare = new NextRequest("http://localhost/api/v1/mesh/heartbeat");
    await expect(requireMeshPeer(bare)).rejects.toThrow("Unauthorized");
    await expect(requireMeshPeer(request(""))).rejects.toThrow("Unauthorized");
  });

  it("rejects a token with no peer row — deleting a peer revokes it", async () => {
    mockFindFirst.mockResolvedValue(undefined);
    await expect(requireMeshPeer(request())).rejects.toThrow("Unauthorized");
  });

  it("rejects visible peers, which have no tunnel to us", async () => {
    mockFindFirst.mockResolvedValue(peer({ connectionType: "visible" }));
    await expect(requireMeshPeer(request())).rejects.toThrow("Unauthorized");
  });

  it("rejects a dev peer that has gone idle past the expiry window", async () => {
    mockFindFirst.mockResolvedValue(
      peer({ type: "dev", lastSeenAt: new Date(Date.now() - DEV_PEER_MAX_IDLE_MS - 1000) }),
    );
    await expect(requireMeshPeer(request())).rejects.toThrow("Unauthorized");
  });

  it("accepts a dev peer seen inside the window", async () => {
    mockFindFirst.mockResolvedValue(peer({ type: "dev", lastSeenAt: new Date() }));
    await expect(requireMeshPeer(request())).resolves.toMatchObject({ type: "dev" });
  });
});

describe("isPeerTokenExpired", () => {
  const stale = new Date(NOW.getTime() - DEV_PEER_MAX_IDLE_MS - 1000);

  it("never expires persistent peers", () => {
    expect(isPeerTokenExpired({ type: "persistent", lastSeenAt: stale, createdAt: stale }, NOW)).toBe(false);
  });

  it("expires an idle dev peer", () => {
    expect(isPeerTokenExpired({ type: "dev", lastSeenAt: stale, createdAt: stale }, NOW)).toBe(true);
  });

  it("falls back to createdAt for a dev peer never seen", () => {
    expect(isPeerTokenExpired({ type: "dev", lastSeenAt: null, createdAt: stale }, NOW)).toBe(true);
    expect(isPeerTokenExpired({ type: "dev", lastSeenAt: null, createdAt: NOW }, NOW)).toBe(false);
  });
});
