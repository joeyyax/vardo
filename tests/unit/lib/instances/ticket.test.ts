// Instance sign-in tickets: opt-in, verified email, two-factor policy, single use and expiry.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  redis: new Map<string, { value: string; expires: number }>(),
  redisDown: false,
  now: 1_000_000,
  user: null as null | { id: string; email: string; emailVerified: boolean; twoFactorEnabled: boolean | null },
  peer: null as null | { id: string; name: string; instanceId: string; connectionType: string; acceptInstanceSignin: boolean },
  member: true,
  totp: true,
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    set: async (key: string, value: string, _px: string, ttl: number, _nx: string) => {
      if (state.redisDown) throw new Error("down");
      const hit = state.redis.get(key);
      if (hit && hit.expires > state.now) return null;
      state.redis.set(key, { value, expires: state.now + ttl });
      return "OK";
    },
    getdel: async (key: string) => {
      if (state.redisDown) throw new Error("down");
      const hit = state.redis.get(key);
      state.redis.delete(key);
      return hit && hit.expires > state.now ? hit.value : null;
    },
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: async () => state.user },
      meshPeers: { findFirst: async () => state.peer },
      memberships: { findFirst: async () => (state.member ? { organizationId: "org-1" } : null) },
    },
  },
}));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "edge" }));
vi.mock("@/lib/config/auth-methods", () => ({ isAuthMethodEnabled: (m: string) => (m === "totp" ? state.totp : true) }));

const { issueTicket, redeemTicket, safeNext, TicketError, TICKET_TTL_MS } = await import("@/lib/instances/ticket");

const CALLER = { id: "peer-1", name: "hub", acceptInstanceSignin: true };

function ticketOf(url: string): string {
  return new URL(url).searchParams.get("ticket")!;
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TicketError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  state.redis.clear();
  state.redisDown = false;
  state.now = 1_000_000;
  state.user = { id: "u1", email: "owner@example.com", emailVerified: true, twoFactorEnabled: false };
  state.peer = { id: "peer-1", name: "hub", instanceId: "inst-hub", connectionType: "direct", acceptInstanceSignin: true };
  state.member = true;
  state.totp = true;
});

describe("issueTicket", () => {
  it("issues a 60-second ticket to the redeem endpoint", async () => {
    const { url, expiresAt } = await issueTicket(CALLER, { email: "Owner@example.com", secondFactor: false }, state.now);
    expect(new URL(url).pathname).toBe("/api/auth/instance-ticket");
    expect(ticketOf(url)).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt - state.now).toBe(TICKET_TTL_MS);
    expect(TICKET_TTL_MS).toBeLessThanOrEqual(60_000);
    // Only the hash is the key; the raw ticket never sits in Redis.
    expect([...state.redis.keys()].some((k) => k.includes(ticketOf(url)))).toBe(false);
  });

  it("refuses when this link doesn't accept sign-ins", async () => {
    const res = await refusal(issueTicket({ ...CALLER, acceptInstanceSignin: false }, { email: "owner@example.com", secondFactor: false }));
    expect(res.status).toBe(403);
    expect(res.message).toContain("doesn't accept sign-ins from hub");
  });

  it("refuses an unknown email", async () => {
    state.user = null;
    expect((await refusal(issueTicket(CALLER, { email: "nobody@example.com", secondFactor: false }))).status).toBe(403);
  });

  it("refuses an unverified email", async () => {
    state.user!.emailVerified = false;
    const res = await refusal(issueTicket(CALLER, { email: "owner@example.com", secondFactor: false }));
    expect(res.status).toBe(403);
    expect(res.message).toContain("verified email");
  });

  it("refuses a two-factor account when the originating session didn't pass a second factor", async () => {
    state.user!.twoFactorEnabled = true;
    const res = await refusal(issueTicket(CALLER, { email: "owner@example.com", secondFactor: false }));
    expect(res.status).toBe(403);
    expect(res.message).toContain("two-factor");
    expect(state.redis.size).toBe(0);
  });

  it("issues for a two-factor account when the originating session passed one", async () => {
    state.user!.twoFactorEnabled = true;
    await expect(issueTicket(CALLER, { email: "owner@example.com", secondFactor: true })).resolves.toHaveProperty("url");
  });

  it("doesn't ask for two-factor when this instance has it turned off", async () => {
    state.user!.twoFactorEnabled = true;
    state.totp = false;
    await expect(issueTicket(CALLER, { email: "owner@example.com", secondFactor: false })).resolves.toHaveProperty("url");
  });

  it("fails closed when Redis is down", async () => {
    state.redisDown = true;
    expect((await refusal(issueTicket(CALLER, { email: "owner@example.com", secondFactor: false }))).status).toBe(503);
  });
});

describe("redeemTicket", () => {
  async function issue(over: Record<string, unknown> = {}) {
    const { url } = await issueTicket(CALLER, { email: "owner@example.com", secondFactor: false, ...over }, state.now);
    return ticketOf(url);
  }

  it("redeems once for the user it names", async () => {
    const ticket = await issue({ next: "/apps/web", organizationId: "org-1" });
    const redeemed = await redeemTicket(ticket, state.now);
    expect(redeemed).toEqual({
      userId: "u1",
      peer: { id: "peer-1", name: "hub", instanceId: "inst-hub" },
      next: "/apps/web",
      organizationId: "org-1",
    });

    const again = await refusal(redeemTicket(ticket, state.now));
    expect(again.status).toBe(403);
    expect(again.message).toContain("expired or was already used");
  });

  it("refuses an expired ticket", async () => {
    const ticket = await issue();
    state.now += TICKET_TTL_MS + 1;
    expect((await refusal(redeemTicket(ticket, state.now))).message).toContain("expired");
  });

  it("refuses a ticket it never issued and a malformed one", async () => {
    expect((await refusal(redeemTicket("f".repeat(64), state.now))).status).toBe(403);
    expect((await refusal(redeemTicket("not-a-ticket", state.now))).status).toBe(400);
  });

  it("refuses when sign-ins were turned off after issue", async () => {
    const ticket = await issue();
    state.peer!.acceptInstanceSignin = false;
    expect((await refusal(redeemTicket(ticket, state.now))).message).toContain("no longer accepts");
  });

  it("refuses when the user lost their verified email after issue", async () => {
    const ticket = await issue();
    state.user!.emailVerified = false;
    expect((await refusal(redeemTicket(ticket, state.now))).status).toBe(403);
  });

  it("refuses when the user turned on two-factor after a ticket issued without it", async () => {
    const ticket = await issue();
    state.user!.twoFactorEnabled = true;
    expect((await refusal(redeemTicket(ticket, state.now))).message).toContain("two-factor");
  });

  it("drops a landing org the user doesn't belong to and an off-site next", async () => {
    state.member = false;
    const ticket = await issue({ next: "//evil.example.com/x", organizationId: "org-9" });
    const redeemed = await redeemTicket(ticket, state.now);
    expect(redeemed.organizationId).toBeNull();
    expect(redeemed.next).toBe("/projects");
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths and drops everything else", () => {
    expect(safeNext("/projects/web")).toBe("/projects/web");
    expect(safeNext("https://example.com/")).toBe("/projects");
    expect(safeNext("/\\example.com")).toBe("/projects");
    expect(safeNext("javascript:alert(1)")).toBe("/projects");
    expect(safeNext(undefined)).toBe("/projects");
  });
});
