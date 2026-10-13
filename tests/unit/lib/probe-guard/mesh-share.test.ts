import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));

import { PROBE_BANS_PATH, PROBE_LIFTS_PATH, receiveSharedBan, receiveSharedLift, shareBan, shareLift, sharePayload } from "@/lib/probe-guard/mesh-share";
import { signMeshRequest, verifyMeshSignature } from "@/lib/mesh/signing";
import { hashMeshToken } from "@/lib/mesh/auth";
import type { BanRequest } from "@/lib/probe-guard/bans";

const expiresAt = new Date("2030-01-01T00:00:00Z");

describe("shareBan", () => {
  it("sends only the address, reason and expiry to every linked instance", async () => {
    const post = vi.fn(async () => ({}));
    const result = await shareBan(
      { ip: "203.0.113.5", reason: "threshold", expiresAt },
      { peers: async () => [{ id: "p1", name: "a" }, { id: "p2", name: "b" }], post },
    );
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(post).toHaveBeenCalledWith("p1", PROBE_BANS_PATH, { ip: "203.0.113.5", reason: "threshold", expiresAt: expiresAt.toISOString() });
  });

  it("never re-shares a ban that came from another instance", async () => {
    const post = vi.fn(async () => ({}));
    const peers = async () => [{ id: "p1", name: "a" }];
    expect(await shareBan({ ip: "203.0.113.5", reason: "mesh", expiresAt }, { peers, post })).toEqual({ sent: 0, failed: 0 });
    expect(await shareBan({ ip: "203.0.113.5", reason: "threshold", expiresAt, originPeerId: "p9" }, { peers, post })).toEqual({ sent: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  it("counts a peer that refuses as failed without throwing", async () => {
    const post = vi.fn(async (id: string) => {
      if (id === "p2") throw new Error("This instance doesn't accept shared bans");
      return {};
    });
    const result = await shareBan({ ip: "203.0.113.5", reason: "trap", expiresAt }, { peers: async () => [{ id: "p1", name: "a" }, { id: "p2", name: "b" }], post });
    expect(result).toEqual({ sent: 1, failed: 1 });
  });

  it("refuses a malformed address", () => {
    expect(sharePayload({ ip: "nope", reason: "trap", expiresAt })).toBeNull();
  });
});

describe("receiveSharedBan", () => {
  const peer = { id: "p1", name: "east" };
  const body = { ip: "203.0.113.5", reason: "threshold", expiresAt: expiresAt.toISOString() };

  it("refuses when this instance hasn't opted in", async () => {
    const ban = vi.fn();
    const res = await receiveSharedBan(peer, body, { sharingEnabled: async () => false, ban });
    expect(res.status).toBe(403);
    expect(ban).not.toHaveBeenCalled();
  });

  it("applies the ban as a mesh ban with the remote expiry", async () => {
    const calls: BanRequest[] = [];
    const res = await receiveSharedBan(peer, body, {
      sharingEnabled: async () => true,
      ban: async (req) => {
        calls.push(req);
        return { status: "refused", reason: "x" };
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ ip: "203.0.113.5", reason: "mesh", origin: { peerId: "p1", name: "east", expiresAt } }]);
  });

  it("refuses extra fields, a re-shared mesh ban and bad addresses", async () => {
    const deps = { sharingEnabled: async () => true, ban: vi.fn() };
    expect((await receiveSharedBan(peer, { ...body, app: "x" }, deps)).status).toBe(400);
    expect((await receiveSharedBan(peer, { ...body, reason: "mesh" }, deps)).status).toBe(400);
    expect((await receiveSharedBan(peer, { ...body, ip: "1.2.3.4`)" }, deps)).status).toBe(400);
    expect(deps.ban).not.toHaveBeenCalled();
  });
});

describe("signature", () => {
  it("accepts a ban signed with the peer's token and rejects a tampered one", () => {
    const token = "t".repeat(48);
    const payload = JSON.stringify({ ip: "203.0.113.5", reason: "threshold", expiresAt: expiresAt.toISOString() });
    const headers = new Headers(signMeshRequest({ token, method: "POST", path: PROBE_BANS_PATH, body: payload }));
    const tokenHash = hashMeshToken(token);
    expect(verifyMeshSignature({ tokenHash, method: "POST", path: PROBE_BANS_PATH, body: payload, headers }).ok).toBe(true);
    const tampered = payload.replace("203.0.113.5", "198.51.100.1");
    expect(verifyMeshSignature({ tokenHash, method: "POST", path: PROBE_BANS_PATH, body: tampered, headers }).ok).toBe(false);
    expect(verifyMeshSignature({ tokenHash: hashMeshToken("other"), method: "POST", path: PROBE_BANS_PATH, body: payload, headers }).ok).toBe(false);
  });
});

describe("shareLift", () => {
  it("sends only the address to every linked instance", async () => {
    const post = vi.fn(async () => ({}));
    const result = await shareLift("203.0.113.5", { peers: async () => [{ id: "p1", name: "a" }, { id: "p2", name: "b" }], post });
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(post).toHaveBeenCalledWith("p1", PROBE_LIFTS_PATH, { ip: "203.0.113.5" });
    expect(post).toHaveBeenCalledWith("p2", PROBE_LIFTS_PATH, { ip: "203.0.113.5" });
  });

  it("counts an instance that refuses or predates the endpoint as failed, without throwing", async () => {
    const post = vi.fn(async (id: string) => {
      if (id === "p2") throw new Error("404");
      return {};
    });
    const result = await shareLift("203.0.113.5", { peers: async () => [{ id: "p1", name: "a" }, { id: "p2", name: "b" }], post });
    expect(result).toEqual({ sent: 1, failed: 1 });
  });

  it("sends nothing for something that isn't an address", async () => {
    const post = vi.fn();
    expect(await shareLift("1.2.3.4`)", { peers: async () => [{ id: "p1", name: "a" }], post })).toEqual({ sent: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("receiveSharedLift", () => {
  const peer = { id: "p1", name: "east" };

  it("refuses when this instance hasn't opted in", async () => {
    const lift = vi.fn();
    expect((await receiveSharedLift(peer, { ip: "203.0.113.5" }, { sharingEnabled: async () => false, lift })).status).toBe(403);
    expect(lift).not.toHaveBeenCalled();
  });

  it("lifts the normalized address and reports how many bans ended", async () => {
    const lift = vi.fn(async () => 2);
    const res = await receiveSharedLift(peer, { ip: "2001:DB8::1" }, { sharingEnabled: async () => true, lift });
    expect(res).toEqual({ status: 200, body: { ok: true, lifted: 2 } });
    expect(lift).toHaveBeenCalledWith("2001:db8::1", peer);
  });

  it("is fine with an address nothing is banned for", async () => {
    const res = await receiveSharedLift(peer, { ip: "203.0.113.9" }, { sharingEnabled: async () => true, lift: async () => 0 });
    expect(res).toEqual({ status: 200, body: { ok: true, lifted: 0 } });
  });

  it("refuses extra fields, ranges and bad addresses", async () => {
    const deps = { sharingEnabled: async () => true, lift: vi.fn() };
    for (const bad of [{ ip: "203.0.113.5", all: true }, { ip: "203.0.113.0/24" }, { ip: "1.2.3.4`)" }, { ip: "" }, {}, null, "203.0.113.5"]) {
      expect((await receiveSharedLift(peer, bad, deps)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(deps.lift).not.toHaveBeenCalled();
  });
});

describe("signature binds the path", () => {
  it("doesn't let a signed ban request be replayed as a lift", () => {
    const token = "t".repeat(48);
    const payload = JSON.stringify({ ip: "203.0.113.5" });
    const headers = new Headers(signMeshRequest({ token, method: "POST", path: PROBE_BANS_PATH, body: payload }));
    const tokenHash = hashMeshToken(token);
    expect(verifyMeshSignature({ tokenHash, method: "POST", path: PROBE_BANS_PATH, body: payload, headers }).ok).toBe(true);
    expect(verifyMeshSignature({ tokenHash, method: "POST", path: PROBE_LIFTS_PATH, body: payload, headers }).ok).toBe(false);
  });
});
