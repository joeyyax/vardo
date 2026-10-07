import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const updated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/with-rate-limit", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit", () => ({ slidingWindowRateLimit: async () => ({ limited: false }) }));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: async (orgId: string) => ({
    organization: { id: orgId },
    membership: { role: "member" },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/docker/deploy", () => ({ stopProject: vi.fn() }));
vi.mock("@/lib/docker/app-dir-owner", () => ({
  assertAppDirOwnership: vi.fn(),
  AppDirOwnershipError: class extends Error {},
  removeAppDir: vi.fn(),
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: {
        findFirst: vi.fn(async () => ({
          id: "a1",
          name: "web",
          organizationId: "o1",
          projectId: null,
          isSystemManaged: false,
          composeContent: null,
        })),
      },
      memberships: { findFirst: vi.fn(async () => ({ id: "m1", role: "member" })) },
    },
    update: () => ({
      set: (values: unknown) => {
        updated(values);
        return { where: () => ({ returning: async () => [{ id: "a1", ...(values as object) }] }) };
      },
    }),
  },
}));

const { PATCH } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/route");
const { registerUpdateApp } = await import("@/lib/mcp/tools/update-app");

const patch = (body: unknown) =>
  (PATCH as (r: NextRequest, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost/api/v1/organizations/o1/apps/a1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: "o1", appId: "a1" }) },
  );

async function mcpUpdate(config: Record<string, unknown>) {
  const server = new McpServer({ name: "test", version: "0" });
  registerUpdateApp(server, { userId: "u1", organizationId: "o1", crossOrg: false } as never);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: "vardo_update_app", arguments: { appId: "a1", config } });
  } finally {
    await client.close();
  }
}

const BAD = [
  { gitBranch: "--prune" },
  { gitBranch: "-v" },
  { gitUrl: "/srv/apps/other/repo" },
  { gitUrl: "file:///etc" },
  { gitUrl: "--upload-pack=touch /tmp/pwned" },
  { gitUrl: "ssh://git@example.com/acme/web.git" },
];

beforeEach(() => updated.mockReset());

describe("app git fields on update", () => {
  for (const body of BAD) {
    it(`PATCH refuses ${JSON.stringify(body)}`, async () => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(updated).not.toHaveBeenCalled();
    });

    it(`vardo_update_app refuses ${JSON.stringify(body)}`, async () => {
      const res = await mcpUpdate(body);
      expect(res.isError).toBe(true);
      expect(updated).not.toHaveBeenCalled();
    });
  }

  it("PATCH accepts an ordinary branch and HTTPS URL", async () => {
    const body = { gitBranch: "release/1.2", gitUrl: "https://github.com/acme/web.git" };
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(updated).toHaveBeenCalledWith(expect.objectContaining(body));
  });

  it("vardo_update_app accepts an ordinary branch and HTTPS URL", async () => {
    const res = await mcpUpdate({ gitBranch: "main", gitUrl: "https://github.com/acme/web.git" });
    expect(res.isError).toBeFalsy();
    expect(updated).toHaveBeenCalled();
  });
});
