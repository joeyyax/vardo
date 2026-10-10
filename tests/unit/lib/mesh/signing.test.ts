// Signed peer calls: tamper, staleness, wrong key and replay are rejected.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashMeshToken } from "@/lib/mesh/auth";

const seen = vi.hoisted(() => new Set<string>());
const redisSet = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    if (seen.has(key)) return null;
    seen.add(key);
    return "OK";
  })
);
vi.mock("@/lib/redis", () => ({ redis: { set: redisSet } }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { claimNonce, signMeshRequest, verifyMeshSignature, MAX_SKEW_MS } from "@/lib/mesh/signing";

const token = "a".repeat(64);
const path = "/api/v1/mesh/mcp-call";
const body = JSON.stringify({ tool: "vardo_list_apps" });
const now = 1_800_000_000_000;

function verify(headers: Record<string, string>, over: Partial<{ body: string; path: string; tokenHash: string; now: number }> = {}) {
  return verifyMeshSignature({
    tokenHash: over.tokenHash ?? hashMeshToken(token),
    method: "POST",
    path: over.path ?? path,
    body: over.body ?? body,
    headers: new Headers(headers),
    now: over.now ?? now,
  });
}

beforeEach(() => {
  seen.clear();
  redisSet.mockClear();
});

describe("mesh request signing", () => {
  it("verifies with the hash the receiver stores", () => {
    expect(verify(signMeshRequest({ token, method: "POST", path, body, now })).ok).toBe(true);
  });

  it("rejects a changed body or path", () => {
    const headers = signMeshRequest({ token, method: "POST", path, body, now });
    expect(verify(headers, { body: body.replace("list", "delete") })).toMatchObject({ ok: false, reason: "Bad signature" });
    expect(verify(headers, { path: "/api/v1/mesh/pull" }).ok).toBe(false);
  });

  it("rejects another peer's key", () => {
    const headers = signMeshRequest({ token, method: "POST", path, body, now });
    expect(verify(headers, { tokenHash: hashMeshToken("b".repeat(64)) }).ok).toBe(false);
  });

  it("rejects a stale or future timestamp", () => {
    const headers = signMeshRequest({ token, method: "POST", path, body, now });
    expect(verify(headers, { now: now + MAX_SKEW_MS + 1 }).ok).toBe(false);
    expect(verify(headers, { now: now - MAX_SKEW_MS - 1 }).ok).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(verify({}).ok).toBe(false);
    const headers = signMeshRequest({ token, method: "POST", path, body, now });
    expect(verify({ ...headers, "x-vardo-mesh-nonce": "nope" }).ok).toBe(false);
  });
});

describe("claimNonce", () => {
  it("accepts a nonce once per peer", async () => {
    expect(await claimNonce("p1", "n".repeat(32))).toBe(true);
    expect(await claimNonce("p1", "n".repeat(32))).toBe(false);
    expect(await claimNonce("p2", "n".repeat(32))).toBe(true);
  });

  it("fails closed when Redis is down", async () => {
    redisSet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await claimNonce("p1", "m".repeat(32))).toBe(false);
  });
});
