import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vardo_delete_app takes the same role as REST DELETE: owner or admin in the
// app's own org.
// ---------------------------------------------------------------------------
// Under test: lib/mcp/tools/delete-app.ts

const appFindFirst = vi.fn();
const membershipFindFirst = vi.fn();
const deleteApp = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => appFindFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
  },
}));

vi.mock("@/lib/docker/delete-app", () => ({
  deleteApp: (...a: unknown[]) => deleteApp(...a),
}));

vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: async () => ({ limited: false }),
}));

const HOME = "org-sample";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function deleteTool(): Promise<Handler> {
  const { registerDeleteApp } = await import("@/lib/mcp/tools/delete-app");
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
      captured = fn;
    },
  };
  registerDeleteApp(server as never, { userId: "u1", organizationId: HOME, crossOrg: false } as never);
  return captured!;
}

const args = { appId: "a1", deleteVolumes: false, keepVolumes: [] };

beforeEach(() => {
  vi.clearAllMocks();
  appFindFirst.mockResolvedValue({ organizationId: HOME });
  deleteApp.mockResolvedValue({ deleted: true });
});

describe("vardo_delete_app role", () => {
  it("refuses a member", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });

    const res = await (await deleteTool())(args);

    expect(res.isError).toBe(true);
    expect(deleteApp).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("allows an %s", async (role) => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role });

    const res = await (await deleteTool())(args);

    expect(res.isError).toBeUndefined();
    expect(deleteApp).toHaveBeenCalledWith(expect.objectContaining({ appId: "a1", organizationId: HOME }));
  });
});
