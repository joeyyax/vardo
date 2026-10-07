// The peer's bearer token is stored encrypted and read back through one helper.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.ENCRYPTION_MASTER_KEY ??= "b".repeat(64);

const state = vi.hoisted(() => ({
  peer: { apiUrl: "http://10.99.0.2:3000", publicApiUrl: null, outboundToken: "" as string | null, name: "peer" },
}));

vi.mock("@/lib/db", () => ({
  db: { query: { meshPeers: { findFirst: async () => state.peer } } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { encryptSystem, isEncrypted } = await import("@/lib/crypto/encrypt");
const { sealOutboundToken, openOutboundToken } = await import("@/lib/mesh/outbound-token");
const { meshFetch, MeshClientError } = await import("@/lib/mesh/client");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function bearer() {
  return (fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization;
}

describe("sealOutboundToken / openOutboundToken", () => {
  it("round-trips through ciphertext", () => {
    const sealed = sealOutboundToken("raw");
    expect(isEncrypted(sealed)).toBe(true);
    expect(openOutboundToken(sealed)).toBe("raw");
  });

  it("doesn't encrypt twice", () => {
    const sealed = sealOutboundToken("raw");
    expect(sealOutboundToken(sealed)).toBe(sealed);
  });

  it("passes legacy plaintext through", () => {
    expect(openOutboundToken("raw")).toBe("raw");
  });

  it("returns null for ciphertext the running key can't open", () => {
    const running = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = "c".repeat(64);
    const foreign = encryptSystem("raw");
    process.env.ENCRYPTION_MASTER_KEY = running;
    expect(openOutboundToken(foreign)).toBeNull();
  });
});

describe("meshFetch", () => {
  it("sends the decrypted token", async () => {
    state.peer.outboundToken = sealOutboundToken("raw");
    await meshFetch("p", "/x");
    expect(bearer()).toBe("Bearer raw");
  });

  it("sends a legacy plaintext token as is", async () => {
    state.peer.outboundToken = "legacy";
    await meshFetch("p", "/x");
    expect(bearer()).toBe("Bearer legacy");
  });

  it("refuses to send when the token won't decrypt", async () => {
    const running = process.env.ENCRYPTION_MASTER_KEY;
    process.env.ENCRYPTION_MASTER_KEY = "c".repeat(64);
    state.peer.outboundToken = encryptSystem("raw");
    process.env.ENCRYPTION_MASTER_KEY = running;

    const err = await meshFetch("p", "/x").catch((e) => e);

    expect(err).toBeInstanceOf(MeshClientError);
    expect(err.code).toBe("NO_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
