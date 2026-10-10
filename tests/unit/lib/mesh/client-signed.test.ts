// Forwarded calls pick one transport up front and never run twice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  peer: {
    apiUrl: "http://192.0.2.2:3000" as string | null,
    publicApiUrl: "https://peer.example.com" as string | null,
    outboundToken: "t".repeat(64),
    name: "prod",
  },
}));

vi.mock("@/lib/db", () => ({
  db: { query: { meshPeers: { findFirst: async () => state.peer } } },
}));
vi.mock("@/lib/mesh/outbound-token", () => ({ openOutboundToken: (v: string) => v }));

import { meshSignedPost, MeshClientError } from "@/lib/mesh/client";

const fetchMock = vi.fn();
const ok = () => new Response(JSON.stringify({ result: { content: [] } }), { status: 200 });

beforeEach(() => {
  fetchMock.mockReset();
  state.peer.apiUrl = "http://192.0.2.2:3000";
  state.peer.publicApiUrl = "https://peer.example.com";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("meshSignedPost", () => {
  it("sends over the tunnel when the probe answers, signed and with the bearer token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(ok());
    const { transport } = await meshSignedPost("p", "/api/v1/mesh/mcp-call", { a: 1 });
    expect(transport).toBe("tunnel");
    expect(fetchMock.mock.calls[0][0]).toBe("http://192.0.2.2:3000/api/health");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("http://192.0.2.2:3000/api/v1/mesh/mcp-call");
    expect(init.headers.Authorization).toBe(`Bearer ${"t".repeat(64)}`);
    expect(init.headers["x-vardo-mesh-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the HTTPS public URL when the tunnel is down", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok());
    const { transport } = await meshSignedPost("p", "/api/v1/mesh/mcp-call", {});
    expect(transport).toBe("public");
    expect(fetchMock.mock.calls[1][0]).toBe("https://peer.example.com/api/v1/mesh/mcp-call");
  });

  it("uses the public URL when there's no tunnel at all", async () => {
    state.peer.apiUrl = null;
    fetchMock.mockResolvedValueOnce(ok());
    expect((await meshSignedPost("p", "/x", {})).transport).toBe("public");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a plain-HTTP public URL", async () => {
    state.peer.publicApiUrl = "http://peer.example.com";
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const err = await meshSignedPost("p", "/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(MeshClientError);
    expect(err.code).toBe("INSECURE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry on the public URL once the call was sent over the tunnel", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok")).mockRejectedValueOnce(new Error("socket hang up"));
    const err = await meshSignedPost("p", "/x", {}).catch((e) => e);
    expect(err.code).toBe("UNREACHABLE");
    expect(err.message).toMatch(/may have run/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the peer's error message", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "No user with that verified email" }), { status: 403 }));
    const err = await meshSignedPost("p", "/x", {}).catch((e) => e);
    expect(err).toMatchObject({ code: "PEER_ERROR", statusCode: 403, message: "No user with that verified email" });
  });
});
