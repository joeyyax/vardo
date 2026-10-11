// GET /api/v1/instances: an unreachable peer shows as unreachable and the rest still load.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  who: { user: { id: "u1", email: "owner@example.com", emailVerified: true, twoFactorEnabled: false } } as unknown,
}));
const { organizations } = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock("@/lib/instances/session-user", () => ({ instanceUser: async () => state.who }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "home" }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/instances/mesh-directory", () => ({
  instanceDirectory: {
    instances: async () => [
      { id: "edge", name: "edge", status: "online", signIn: true, browse: true },
      { id: "lab", name: "lab", status: "offline", signIn: true, browse: true },
      { id: "solo", name: "solo", status: "online", signIn: true, browse: false },
    ],
    organizations,
  },
}));

const { GET } = await import("@/app/api/v1/instances/route");

beforeEach(() => {
  organizations.mockReset();
  organizations.mockImplementation(async (id: string) =>
    id === "lab" ? { state: "unreachable" } : { state: "ok", data: [{ id: "o1", name: "Alpha", role: "owner" }] },
  );
  state.who = { user: { id: "u1", email: "owner@example.com", emailVerified: true, twoFactorEnabled: false } };
});

describe("GET /api/v1/instances", () => {
  it("returns every opted-in peer, with an unreachable one marked and nothing else affected", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.local).toEqual({ name: "home" });
    expect(body.instances).toEqual([
      expect.objectContaining({ id: "edge", organizations: { state: "ok", data: [{ id: "o1", name: "Alpha", role: "owner" }] } }),
      expect.objectContaining({ id: "lab", status: "offline", organizations: { state: "unreachable" } }),
      expect.objectContaining({ id: "solo", organizations: null }),
    ]);
  });

  it("doesn't ask peers about an unverified email", async () => {
    state.who = { user: { id: "u1", email: "owner@example.com", emailVerified: false, twoFactorEnabled: false } };
    const body = await (await GET()).json();
    expect(organizations).not.toHaveBeenCalled();
    expect(body.instances[0].organizations.state).toBe("refused");
  });

  it("refuses without a browser session", async () => {
    state.who = { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    expect((await GET()).status).toBe(401);
  });
});
