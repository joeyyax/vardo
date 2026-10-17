// The key route sits behind the signed mesh channel and answers an unknown caller with 410.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashMeshToken } from "@/lib/mesh/auth";
import { signMeshRequest } from "@/lib/mesh/signing";

const TOKEN = "e".repeat(64);
const PATH = "/api/v1/mesh/ssh-keys";

const state = vi.hoisted(() => ({
  peer: null as Record<string, unknown> | null,
  keys: new Set<string>(),
  stored: [] as unknown[],
}));

vi.mock("@/lib/mesh/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => {
    if (!state.peer) throw new Error("Unauthorized");
    return state.peer;
  },
}));
vi.mock("@/lib/redis", () => ({
  redis: { set: async (key: string) => (state.keys.has(key) ? null : (state.keys.add(key), "OK")) },
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/mesh/key-exchange", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/key-exchange")>()),
  storePeerKeys: async (_peer: unknown, sent: unknown) => void state.stored.push(sent),
  localKeys: async (peer: { acceptBuilds: boolean }) => ({ sshKey: null, sshHostKey: null, sshPort: null, acceptsBuilds: peer.acceptBuilds, builderKey: null, builder: null }),
}));

const { POST } = await import("@/app/api/v1/mesh/ssh-keys/route");

function request(payload: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(payload);
  return new NextRequest(`http://localhost:3000${PATH}`, {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(headers ?? signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body })) },
  });
}

const PAYLOAD = { acceptsBuilds: false, builderKey: null, builder: null };

beforeEach(() => {
  state.keys.clear();
  state.stored.length = 0;
  state.peer = { id: "peer-1", name: "jy0", tokenHash: hashMeshToken(TOKEN), acceptBuilds: true };
});

describe("POST /api/v1/mesh/ssh-keys", () => {
  it("stores a signed caller's keys and answers with this side's", async () => {
    const res = await POST(request(PAYLOAD), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sshKey: null, sshHostKey: null, sshPort: null, acceptsBuilds: true, builderKey: null, builder: null });
    expect(state.stored).toEqual([PAYLOAD]);
  });

  it("refuses an unsigned request and stores nothing", async () => {
    expect((await POST(request(PAYLOAD, {}), {})).status).toBe(401);
    expect(state.stored).toEqual([]);
  });

  it("refuses a body that doesn't match its signature", async () => {
    const headers = signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body: JSON.stringify({ ...PAYLOAD, acceptsBuilds: true }) });
    expect((await POST(request(PAYLOAD, headers), {})).status).toBe(401);
    expect(state.stored).toEqual([]);
  });

  it("answers 410 to a caller it has no link for", async () => {
    state.peer = null;
    expect((await POST(request(PAYLOAD), {})).status).toBe(410);
  });
});
