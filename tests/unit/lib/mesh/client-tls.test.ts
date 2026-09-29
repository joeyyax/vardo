// Secrets only leave over the WireGuard tunnel or an HTTPS public URL.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  peer: { apiUrl: "http://10.99.0.2:3000", publicApiUrl: "http://peer.example", outboundToken: "t", name: "peer" },
}));

vi.mock("@/lib/db", () => ({
  db: { query: { meshPeers: { findFirst: async () => state.peer } } },
}));

import { meshFetch, MeshClientError } from "@/lib/mesh/client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  state.peer.publicApiUrl = "http://peer.example";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("meshFetch with requireTls", () => {
  it("uses the tunnel when it answers", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    await meshFetch("p", "/x", {}, { requireTls: true });
    expect(fetchMock.mock.calls[0][0]).toBe("http://10.99.0.2:3000/x");
  });

  it("refuses to fall back to a plain-HTTP public URL", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const err = await meshFetch("p", "/x", {}, { requireTls: true }).catch((e) => e);
    expect(err).toBeInstanceOf(MeshClientError);
    expect(err.code).toBe("INSECURE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to an HTTPS public URL", async () => {
    state.peer.publicApiUrl = "https://peer.example";
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(new Response("{}"));
    await meshFetch("p", "/x", {}, { requireTls: true });
    expect(fetchMock.mock.calls[1][0]).toBe("https://peer.example/x");
  });

  it("still falls back to plain HTTP when nothing secret is sent", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(new Response("{}"));
    await meshFetch("p", "/x");
    expect(fetchMock.mock.calls[1][0]).toBe("http://peer.example/x");
  });
});
