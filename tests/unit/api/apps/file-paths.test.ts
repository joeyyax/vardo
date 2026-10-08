import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

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
  { composeFilePath: "../other-app/production/.env" },
  { composeFilePath: "sub/../../x.yml" },
  { composeFilePath: "/etc/passwd" },
  { dockerfilePath: "../Dockerfile" },
  { dockerfilePath: "/etc/shadow" },
];

beforeEach(() => {
  dbMock.reset();
  dbMock.query.apps.findFirst.mockResolvedValue({
    id: "a1",
    name: "web",
    organizationId: "o1",
    projectId: null,
    isSystemManaged: false,
    composeContent: null,
  });
  dbMock.query.memberships.findFirst.mockResolvedValue({ id: "m1", role: "member" });
  dbMock.updateReturns([{ id: "a1" }]);
});

describe("app file paths on update", () => {
  for (const body of BAD) {
    it(`PATCH refuses ${JSON.stringify(body)}`, async () => {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(dbMock.update).not.toHaveBeenCalled();
    });

    it(`vardo_update_app refuses ${JSON.stringify(body)}`, async () => {
      const res = await mcpUpdate(body);
      expect(res.isError).toBe(true);
      expect(dbMock.update).not.toHaveBeenCalled();
    });
  }

  it("vardo_update_app accepts paths inside the repo", async () => {
    const res = await mcpUpdate({ composeFilePath: "deploy/compose.yml", dockerfilePath: "docker/..Dockerfile" });
    expect(res.isError).toBeFalsy();
    expect(dbMock.update).toHaveBeenCalled();
  });
});
