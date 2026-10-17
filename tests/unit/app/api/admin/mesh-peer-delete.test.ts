// Removing a peer closes its builder forward and takes its WireGuard peer out of wg0.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ order: [] as string[], running: true }));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({ user: { id: "admin-1" }, authMethod: "session" }) }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/mesh/builder-forward", () => ({ reconcileBuilderForward: async () => void state.order.push("builder") }));
vi.mock("@/lib/mesh/wireguard", () => ({
  isWireguardRunning: async () => state.running,
  rebuildAndSync: async () => void state.order.push("wg0"),
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: { meshPeers: { findFirst: async () => ({ id: "peer-1" }) } },
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn({ delete: () => ({ where: async () => void state.order.push("deleted") }) });
    },
  },
}));

const { DELETE } = await import("@/app/api/v1/admin/mesh/peers/[peerId]/route");

const remove = () => DELETE(new NextRequest("http://localhost/api/v1/admin/mesh/peers/peer-1", { method: "DELETE" }), { params: Promise.resolve({ peerId: "peer-1" }) });

beforeEach(() => {
  state.order.length = 0;
  state.running = true;
});

describe("DELETE /api/v1/admin/mesh/peers/[peerId]", () => {
  it("drops the peer's builder forward and tunnel after the row", async () => {
    expect((await remove()).status).toBe(200);
    expect(state.order).toEqual(["deleted", "deleted", "builder", "wg0"]);
  });

  it("skips WireGuard when it isn't running", async () => {
    state.running = false;
    await remove();
    expect(state.order).toEqual(["deleted", "deleted", "builder"]);
  });
});
