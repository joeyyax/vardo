// The ticket endpoint sits behind the signed mesh channel: signature, nonce and opt-in.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashMeshToken } from "@/lib/mesh/auth";
import { signMeshRequest } from "@/lib/mesh/signing";

const TOKEN = "d".repeat(64);
const PATH = "/api/v1/mesh/instance-ticket";

const state = vi.hoisted(() => ({
  peer: {} as Record<string, unknown>,
  keys: new Set<string>(),
}));

vi.mock("@/lib/mesh/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => state.peer,
}));
vi.mock("@/lib/redis", () => ({
  redis: {
    set: async (key: string) => {
      if (state.keys.has(key)) return null;
      state.keys.add(key);
      return "OK";
    },
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: async () => ({ id: "u1", email: "owner@example.com", emailVerified: true, twoFactorEnabled: false }) },
    },
  },
}));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "edge" }));
vi.mock("@/lib/config/auth-methods", () => ({ isAuthMethodEnabled: () => true }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());

const { POST } = await import("@/app/api/v1/mesh/instance-ticket/route");

function request(payload: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(payload);
  return new NextRequest(`http://localhost:3000${PATH}`, {
    method: "POST",
    body,
    headers: headers ?? signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body }),
  });
}

const PAYLOAD = { email: "owner@example.com", secondFactor: false };

beforeEach(() => {
  state.keys.clear();
  state.peer = { id: "peer-1", name: "hub", tokenHash: hashMeshToken(TOKEN), acceptInstanceSignin: true };
});

describe("POST /api/v1/mesh/instance-ticket", () => {
  it("issues a ticket for a signed request", async () => {
    const res = await POST(request(PAYLOAD), {});
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("/api/auth/instance-ticket?ticket=");
  });

  it("refuses an unsigned request", async () => {
    expect((await POST(request(PAYLOAD, {}), {})).status).toBe(401);
  });

  it("refuses a replayed request", async () => {
    const body = JSON.stringify(PAYLOAD);
    const headers = signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body });
    expect((await POST(request(PAYLOAD, headers), {})).status).toBe(200);
    expect((await POST(request(PAYLOAD, headers), {})).status).toBe(401);
  });

  it("refuses when the link doesn't accept sign-ins", async () => {
    state.peer.acceptInstanceSignin = false;
    expect((await POST(request(PAYLOAD), {})).status).toBe(403);
  });

  it("rejects fields it doesn't know", async () => {
    expect((await POST(request({ ...PAYLOAD, role: "owner" }), {})).status).toBe(400);
  });
});
