import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("@/lib/auth/admin", () => ({ requireAppAdmin: async () => ({ user: { id: "admin-1" }, authMethod: "session" }) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/self-update/store", () => ({ getRollout: async () => null }));
vi.mock("@/lib/self-update/coordinator", () => {
  class RolloutActionError extends Error {}
  return {
    RolloutActionError,
    isRolloutCoordinator: async () => true,
    actOnRollout: async () => {
      throw h.error;
    },
  };
});

const { POST } = await import("@/app/api/v1/admin/updates/rollout/route");
const { RolloutActionError } = await import("@/lib/self-update/coordinator");

const post = () => POST(new NextRequest("http://localhost/api/v1/admin/updates/rollout", {
  method: "POST", body: JSON.stringify({ action: "retry", rolloutId: "r1" }),
}));

beforeEach(() => { h.error = null; });

describe("POST /api/v1/admin/updates/rollout errors", () => {
  it("maps a rollout action error to 409 with its message", async () => {
    h.error = new RolloutActionError("This rollout has changed");
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This rollout has changed");
  });

  it("does not turn an unrelated error that mentions an instance into a 409", async () => {
    h.error = new Error("connect ECONNREFUSED: instance db unreachable");
    const res = await post();
    expect(res.status).not.toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("ECONNREFUSED");
  });
});
