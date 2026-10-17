// The build-slot route: signed, only for a peer this side builds for, and each caller's tokens kept apart.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashMeshToken } from "@/lib/mesh/auth";
import { signMeshRequest } from "@/lib/mesh/signing";

const TOKEN = "f".repeat(64);
const PATH = "/api/v1/mesh/build-slot";

const state = vi.hoisted(() => ({
  peer: null as Record<string, unknown> | null,
  nonces: new Set<string>(),
  held: new Set<string>(),
  limit: 1,
}));

vi.mock("@/lib/mesh/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => {
    if (!state.peer) throw new Error("Unauthorized");
    return state.peer;
  },
}));
vi.mock("@/lib/redis", () => ({
  redis: { set: async (key: string) => (state.nonces.has(key) ? null : (state.nonces.add(key), "OK")) },
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/docker/build-gate", () => ({
  peerSlotToken: (peerId: string, token: string) => `build:mesh-${peerId}-${token}`,
  claimSlotForPeer: async (token: string) => {
    if (state.held.size >= state.limit) return false;
    state.held.add(token);
    return true;
  },
  renewSlotForPeer: async (token: string) => state.held.has(token),
  releaseSlotForPeer: async (token: string) => void state.held.delete(token),
}));

const { POST } = await import("@/app/api/v1/mesh/build-slot/route");

function request(payload: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(payload);
  return new NextRequest(`http://localhost:3000${PATH}`, {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(headers ?? signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body })) },
  });
}

const send = async (payload: unknown) => {
  const res = await POST(request(payload), {});
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  state.nonces.clear();
  state.held.clear();
  state.limit = 1;
  state.peer = { id: "jy0", name: "jy0", tokenHash: hashMeshToken(TOKEN), acceptBuilds: true };
});

describe("POST /api/v1/mesh/build-slot", () => {
  it("claims, renews and releases a slot under the caller's own token", async () => {
    expect(await send({ action: "claim", token: "dep-a-x1" })).toEqual({ status: 200, body: { held: true } });
    expect([...state.held]).toEqual(["build:mesh-jy0-dep-a-x1"]);
    expect(await send({ action: "renew", token: "dep-a-x1" })).toEqual({ status: 200, body: { held: true } });
    expect(await send({ action: "release", token: "dep-a-x1" })).toEqual({ status: 200, body: { held: false } });
    expect(state.held.size).toBe(0);
    expect(await send({ action: "renew", token: "dep-a-x1" })).toEqual({ status: 200, body: { held: false } });
  });

  it("answers held false while this host's gate is full", async () => {
    state.held.add("dep-own:abc");
    expect(await send({ action: "claim", token: "dep-a-x1" })).toEqual({ status: 200, body: { held: false } });
  });

  it("refuses a peer it doesn't run builds for", async () => {
    state.peer = { ...state.peer!, acceptBuilds: false };
    expect((await send({ action: "claim", token: "dep-a-x1" })).status).toBe(403);
    expect(state.held.size).toBe(0);
  });

  it("refuses an unsigned call, a bad token and an unknown caller", async () => {
    expect((await POST(request({ action: "claim", token: "a" }, {}), {})).status).toBe(401);
    expect((await send({ action: "claim", token: "a:b" })).status).toBe(400);
    expect((await send({ action: "take", token: "a" })).status).toBe(400);
    state.peer = null;
    expect((await send({ action: "claim", token: "a" })).status).toBe(410);
    expect(state.held.size).toBe(0);
  });
});
