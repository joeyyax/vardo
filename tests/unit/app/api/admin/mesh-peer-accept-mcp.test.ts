// Only a signed-in instance admin lets a peer forward MCP calls here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ authMethod: "session" as "session" | "token", set: null as unknown }));

vi.mock("@/lib/auth/admin", () => ({
  requireAppAdmin: async () => ({ user: { id: "admin-1" }, authMethod: state.authMethod }),
}));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        state.set = values;
        return { where: () => ({ returning: async () => [{ id: "peer-1", acceptMcp: true }] }) };
      },
    }),
  },
}));

const { PATCH } = await import("@/app/api/v1/admin/mesh/peers/[peerId]/route");

const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/v1/admin/mesh/peers/peer-1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ peerId: "peer-1" }),
  });

beforeEach(() => {
  state.authMethod = "session";
  state.set = null;
});

describe("PATCH /api/v1/admin/mesh/peers/[peerId] acceptMcp", () => {
  it("is set by an admin's session", async () => {
    const res = await patch({ acceptMcp: true });
    expect(res.status).toBe(200);
    expect(state.set).toMatchObject({ acceptMcp: true });
  });

  it("is refused to an admin-scoped token", async () => {
    state.authMethod = "token";
    const res = await patch({ acceptMcp: true });
    expect(res.status).toBe(403);
    expect(state.set).toBeNull();
  });

  it("rejects an empty change", async () => {
    expect((await patch({})).status).toBe(400);
  });
});
