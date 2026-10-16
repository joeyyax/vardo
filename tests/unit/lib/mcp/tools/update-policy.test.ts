import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";

// The update policy tools exist only for an admin-scoped token held by a live instance admin.

const h = vi.hoisted(() => ({
  instanceAdmin: vi.fn(async () => true),
  policy: { mode: "notify", priority: "standard", channel: null } as Record<string, unknown>,
  save: vi.fn(),
}));

vi.mock("@/lib/auth/system-org", () => ({ isInstanceAdminUser: h.instanceAdmin }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/self-update/store", () => ({ getUpdatePolicy: async () => ({ ...h.policy }) }));
vi.mock("@/lib/self-update/save-policy", () => ({ saveUpdatePolicy: h.save }));

import { registerUpdatePolicyTools } from "@/lib/mcp/tools/update-policy";

const tools = (c = adminContext) => captureTools(registerUpdatePolicyTools, c);
const get = () => tools().get("vardo_get_update_policy")!;
const set = () => tools().get("vardo_set_update_policy")!;

beforeEach(() => {
  vi.clearAllMocks();
  h.instanceAdmin.mockResolvedValue(true);
  h.policy = { mode: "notify", priority: "standard", channel: null };
  h.save.mockImplementation(async (next: Record<string, unknown>) => next);
});

describe("update policy tools", () => {
  it("aren't registered without the admin scope", () => {
    expect([...tools(plainContext).keys()]).toEqual([]);
  });

  it("refuse once the user is no longer an instance admin", async () => {
    h.instanceAdmin.mockResolvedValue(false);
    expect((await get()({})).isError).toBe(true);
    expect((await set()({ mode: "auto" })).isError).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("reads the policy with the channel in effect", async () => {
    h.policy = { mode: "auto", priority: "low", channel: null };
    expect(toolBody(await get()({}))).toEqual({ mode: "auto", priority: "low", channel: null, effectiveChannel: "releases" });
  });

  it("merges given fields over the stored policy and saves as the token's user", async () => {
    const body = toolBody(await set()({ channel: "main" }));
    expect(h.save).toHaveBeenCalledWith({ mode: "notify", priority: "standard", channel: "main" }, "u1");
    expect(body).toEqual({ mode: "notify", priority: "standard", channel: "main", effectiveChannel: "main" });
  });

  it("refuses a call with nothing to change", async () => {
    expect((await set()({})).isError).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses an unknown priority", async () => {
    const res = await set()({ priority: "urgent" });
    expect(res.isError).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });
});
