import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vardo_adopt_app reads docker-compose.yml from a caller-chosen host path.
// That is instance-admin power, which API tokens never carry.
// ---------------------------------------------------------------------------
// Under test: lib/mcp/tools/adopt-app.ts

const { userFindFirst, membershipFindFirst, readFileMock, credentialMayAdmin } = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
  readFileMock: vi.fn(),
  credentialMayAdmin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: userFindFirst },
      memberships: { findFirst: membershipFindFirst },
      apps: { findFirst: vi.fn() },
      projects: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return { ...actual, readFile: readFileMock };
});

vi.mock("@/lib/auth/admin", () => ({ credentialMayAdmin }));

vi.mock("@/lib/config/vardo-config", () => ({ readProjectConfig: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function adoptTool(): Promise<Handler> {
  const { registerAdoptApp } = await import("@/lib/mcp/tools/adopt-app");
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
      captured = fn;
    },
  };
  registerAdoptApp(server as never, { userId: "u1", organizationId: "org-1", crossOrg: false } as never);
  return captured!;
}

const args = {
  path: "/opt/vardo/apps/someone-else",
  environmentType: "local",
  newProjectName: "stolen",
};

beforeEach(() => {
  vi.clearAllMocks();
  readFileMock.mockRejectedValue(new Error("ENOENT"));
  credentialMayAdmin.mockReturnValue(false);
});

describe("vardo_adopt_app host path", () => {
  it.each(["member", "admin", "owner"])("refuses an org %s", async (role) => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role });
    userFindFirst.mockResolvedValue({ isAppAdmin: false });

    const res = await (await adoptTool())(args);

    expect(res.isError).toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("refuses an instance admin's token", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "owner" });
    userFindFirst.mockResolvedValue({ isAppAdmin: true });

    const res = await (await adoptTool())(args);

    expect(res.isError).toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("reads the path for an instance admin once the credential may admin", async () => {
    credentialMayAdmin.mockReturnValue(true);
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });
    userFindFirst.mockResolvedValue({ isAppAdmin: true });

    await (await adoptTool())(args);

    expect(readFileMock).toHaveBeenCalled();
  });
});
