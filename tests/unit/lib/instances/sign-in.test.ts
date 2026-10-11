// Originating side of an instance sign-in: opt-in, verified email, the second-factor claim and the returned link.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  peer: null as null | { id: string; name: string; peerAcceptsInstanceSignin: boolean },
  totp: true,
}));
const { meshSignedPost, recordActivity } = vi.hoisted(() => ({
  meshSignedPost: vi.fn(),
  recordActivity: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({ db: { query: { meshPeers: { findFirst: async () => state.peer } } } }));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/config/auth-methods", () => ({ isAuthMethodEnabled: (m: string) => (m === "totp" ? state.totp : true) }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "home" }));
vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/mesh/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/client")>()),
  meshSignedPost,
}));

const { requestInstanceSignIn, checkedRedeemUrl, SignInError } = await import("@/lib/instances/sign-in");
const { MeshClientError } = await import("@/lib/mesh/client");

const TICKET = "a".repeat(64);
const GOOD_URL = `https://edge.example.com/api/auth/instance-ticket?ticket=${TICKET}`;
const WHO = { id: "u1", email: "owner@example.com", emailVerified: true, twoFactorEnabled: false };

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SignInError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.peer = { id: "peer-1", name: "edge", peerAcceptsInstanceSignin: true };
  state.totp = true;
  meshSignedPost.mockResolvedValue({ data: { url: GOOD_URL }, transport: "tunnel" });
});

describe("requestInstanceSignIn", () => {
  it("returns the peer's redeem link and logs it here", async () => {
    const res = await requestInstanceSignIn({ who: WHO, peerId: "peer-1", next: "/apps/web", activityOrgId: "org-1" });
    expect(res.url).toBe(GOOD_URL);
    expect(meshSignedPost).toHaveBeenCalledWith(
      "peer-1",
      "/api/v1/mesh/instance-ticket",
      { email: "owner@example.com", secondFactor: false, next: "/apps/web" },
      expect.any(Object),
    );
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "mesh.instance_signin_sent", organizationId: "org-1" }));
  });

  it("claims a second factor only for a two-factor account on an instance that enforces it", async () => {
    await requestInstanceSignIn({ who: { ...WHO, twoFactorEnabled: true }, peerId: "peer-1" });
    expect(meshSignedPost.mock.calls[0][2]).toMatchObject({ secondFactor: true });

    state.totp = false;
    await requestInstanceSignIn({ who: { ...WHO, twoFactorEnabled: true }, peerId: "peer-1" });
    expect(meshSignedPost.mock.calls[1][2]).toMatchObject({ secondFactor: false });
  });

  it("refuses when the peer hasn't opted in, without calling it", async () => {
    state.peer!.peerAcceptsInstanceSignin = false;
    expect((await refusal(requestInstanceSignIn({ who: WHO, peerId: "peer-1" }))).status).toBe(403);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("refuses an unverified email, without calling the peer", async () => {
    expect((await refusal(requestInstanceSignIn({ who: { ...WHO, emailVerified: false }, peerId: "peer-1" }))).status).toBe(403);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("passes on the peer's refusal and logs the failure", async () => {
    meshSignedPost.mockRejectedValue(new MeshClientError("Your account on edge uses two-factor.", "PEER_ERROR", 403));
    const res = await refusal(requestInstanceSignIn({ who: WHO, peerId: "peer-1", activityOrgId: "org-1" }));
    expect(res).toEqual({ status: 403, message: "Your account on edge uses two-factor." });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "mesh.instance_signin_failed" }));
  });

  it("reports an unreachable peer as a 502", async () => {
    meshSignedPost.mockRejectedValue(new MeshClientError("unreachable", "UNREACHABLE"));
    expect((await refusal(requestInstanceSignIn({ who: WHO, peerId: "peer-1" }))).status).toBe(502);
  });

  it("refuses a link that isn't the peer's redeem endpoint", async () => {
    meshSignedPost.mockResolvedValue({ data: { url: "javascript:alert(1)" }, transport: "tunnel" });
    expect((await refusal(requestInstanceSignIn({ who: WHO, peerId: "peer-1" }))).status).toBe(502);
  });
});

describe("checkedRedeemUrl", () => {
  it("accepts only an http(s) redeem link with a well-formed ticket", () => {
    expect(checkedRedeemUrl(GOOD_URL)).toBe(GOOD_URL);
    expect(checkedRedeemUrl(`https://edge.example.com/login?ticket=${TICKET}`)).toBeNull();
    expect(checkedRedeemUrl("https://edge.example.com/api/auth/instance-ticket?ticket=short")).toBeNull();
    expect(checkedRedeemUrl(`https://user:pw@edge.example.com/api/auth/instance-ticket?ticket=${TICKET}`)).toBeNull();
    expect(checkedRedeemUrl(42)).toBeNull();
  });
});
