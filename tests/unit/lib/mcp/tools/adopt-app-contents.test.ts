import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vardo_adopt_app takes compose content, never a host path. Permission matches
// POST /api/v1/organizations/[orgId]/adopt: org membership, any role.
// ---------------------------------------------------------------------------
// Under test: lib/mcp/tools/adopt-app.ts

const h = vi.hoisted(() => ({
  membershipFindFirst: vi.fn(),
  appsFindFirst: vi.fn(),
  readFile: vi.fn(),
  readFileSync: vi.fn(),
  insertedApp: vi.fn(),
  featureEnabled: vi.fn(),
}));

function tx() {
  return {
    query: { projects: { findFirst: vi.fn() } },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if (v.deployType) h.insertedApp(v);
        return { returning: async () => [{ id: "app-1", ...v }] };
      },
    }),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      memberships: { findFirst: h.membershipFindFirst },
      apps: { findFirst: h.appsFindFirst },
      projects: { findFirst: vi.fn() },
      organizations: { findFirst: vi.fn().mockResolvedValue({ trusted: false }) },
    },
    transaction: async (fn: (t: unknown) => unknown) => fn(tx()),
  },
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return { ...actual, readFile: h.readFile };
});
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: h.readFileSync, default: { ...actual, readFileSync: h.readFileSync } };
});

vi.mock("@/lib/config/features", () => ({
  isFeatureEnabledAsync: h.featureEnabled,
  isFeatureEnabled: () => false,
}));
vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: vi.fn().mockResolvedValue({ limited: false }),
}));
vi.mock("@/lib/db/app-name", () => ({
  APP_NAME_TAKEN_ERROR: "taken",
  isAppNameViolation: () => false,
  isTopLevelAppNameTaken: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/system-settings", () => ({
  getSslConfig: vi.fn().mockResolvedValue({}),
  getPrimaryIssuer: () => "letsencrypt",
  getDefaultCertResolver: () => "letsencrypt",
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docker/import", () => ({
  resolveProjectForImport: vi.fn().mockResolvedValue("proj-1"),
}));

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

let schema: Record<string, unknown>;

async function adoptTool(): Promise<Handler> {
  const { registerAdoptApp } = await import("@/lib/mcp/tools/adopt-app");
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, s: Record<string, unknown>, fn: Handler) => {
      schema = s;
      captured = fn;
    },
  };
  registerAdoptApp(server as never, { userId: "u1", organizationId: "org-1", crossOrg: false } as never);
  return captured!;
}

const compose = "services:\n  web:\n    image: nginx\n";
const args = {
  composeContent: compose,
  name: "my-app",
  displayName: "My App",
  newProjectName: "proj",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.featureEnabled.mockResolvedValue(true);
  h.appsFindFirst.mockResolvedValue(undefined);
});

describe("vardo_adopt_app", () => {
  it("takes no path parameter", async () => {
    await adoptTool();
    expect(Object.keys(schema)).not.toContain("path");
    expect(Object.keys(schema)).toContain("composeContent");
  });

  it.each(["member", "admin", "owner"])("adopts compose content for an org %s", async (role) => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role });

    const res = await (await adoptTool())(args);

    expect(res.isError).toBeUndefined();
    expect(h.insertedApp).toHaveBeenCalledTimes(1);
    expect(h.insertedApp.mock.calls[0][0].composeContent).toContain("nginx");
  });

  it("refuses a caller with no membership in the org", async () => {
    h.membershipFindFirst.mockResolvedValue(undefined);

    const res = await (await adoptTool())(args);

    expect(res.isError).toBe(true);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });

  it("refuses when container-import is off, as REST does", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });
    h.featureEnabled.mockResolvedValue(false);

    const res = await (await adoptTool())(args);

    expect(res.isError).toBe(true);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });

  it("never reads the host filesystem", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });

    await (await adoptTool())({ ...args, path: "/etc" });

    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it("rejects oversize compose", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });
    const big = compose + "# " + "x".repeat(300 * 1024);

    const res = await (await adoptTool())({ ...args, composeContent: big });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/limited/);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });

  it("rejects invalid compose", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });

    const res = await (await adoptTool())({ ...args, composeContent: "not: [valid" });

    expect(res.isError).toBe(true);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });

  it("rejects a privileged service in an untrusted org", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });
    const priv = "services:\n  web:\n    image: nginx\n    privileged: true\n";

    const res = await (await adoptTool())({ ...args, composeContent: priv });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/privileged/);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });

  it("rejects a blocked host mount", async () => {
    h.membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });
    const mount = "services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/s\n";

    const res = await (await adoptTool())({ ...args, composeContent: mount });

    expect(res.isError).toBe(true);
    expect(h.insertedApp).not.toHaveBeenCalled();
  });
});
