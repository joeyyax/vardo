// The key route sits behind the signed mesh channel and answers an unknown caller with 410.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashMeshToken } from "@/lib/mesh/auth";
import { signMeshRequest } from "@/lib/mesh/signing";

const TOKEN = "e".repeat(64);
const PATH = "/api/v1/mesh/ssh-keys";
const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGI6/QR1fwt33EFMygRHuBK82QAh42lFkI8Qzdfxv3Ts";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK90j9wHyHnIT5iWOwJyQR0rHdrJmQ04c5uM5t7f56qU";

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
vi.mock("@/lib/mesh/ssh-exchange", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/ssh-exchange")>()),
  storePeerSsh: async (_peer: unknown, sent: unknown) => void state.stored.push(sent),
  localSshKeys: async (peer: { acceptBuilds: boolean }) => ({ sshKey: KEY_B, sshHostKey: KEY_A, sshPort: 22, acceptsBuilds: peer.acceptBuilds }),
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

const PAYLOAD = { sshKey: KEY_A, sshHostKey: KEY_B, sshPort: 22, acceptsBuilds: false };

beforeEach(() => {
  state.keys.clear();
  state.stored.length = 0;
  state.peer = { id: "peer-1", name: "jy0", tokenHash: hashMeshToken(TOKEN), acceptBuilds: true, peerSshKey: null };
});

describe("POST /api/v1/mesh/ssh-keys", () => {
  it("stores a signed caller's keys and answers with this side's", async () => {
    const res = await POST(request(PAYLOAD), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sshKey: KEY_B, sshHostKey: KEY_A, sshPort: 22, acceptsBuilds: true });
    expect(state.stored).toEqual([PAYLOAD]);
  });

  it("refuses an unsigned request and stores nothing", async () => {
    expect((await POST(request(PAYLOAD, {}), {})).status).toBe(401);
    expect(state.stored).toEqual([]);
  });

  it("refuses a body that doesn't match its signature", async () => {
    const headers = signMeshRequest({ token: TOKEN, method: "POST", path: PATH, body: JSON.stringify({ ...PAYLOAD, sshKey: KEY_B }) });
    expect((await POST(request(PAYLOAD, headers), {})).status).toBe(401);
    expect(state.stored).toEqual([]);
  });

  it("answers 410 to a caller it has no link for", async () => {
    state.peer = null;
    expect((await POST(request(PAYLOAD), {})).status).toBe(410);
  });
});
