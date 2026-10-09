// #813: a member session is refused the terminal and every secret reveal; an admin gets through.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { dbMock } from "@/tests/helpers/db";

process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);

const h = vi.hoisted(() => ({ role: "member" }));

vi.mock("@/lib/auth/session", () => ({
  requireOrg: async () => ({
    organization: { id: "org-1" },
    membership: { role: h.role },
    session: { user: { id: "u1" } },
  }),
}));
vi.mock("@/lib/auth/admin", () => ({ isAppAdmin: async () => false }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/docker/client", () => ({
  listContainers: vi.fn(async () => [
    { id: "c-1", name: "c-1", image: "img", state: "running", status: "Up", ports: [], labels: { "vardo.project.id": "app-1" } },
  ]),
}));
vi.mock("@/lib/docker/exec", () => ({
  createExec: vi.fn(async () => "exec-1"),
  startExec: vi.fn(async () => ({ on: vi.fn(), destroy: vi.fn(), destroyed: false })),
  resizeExec: vi.fn(),
}));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/docker/environment-env", () => ({
  loadEnvironmentEnv: vi.fn(async () => null),
  saveEnvironmentEnv: vi.fn(),
}));

const terminal = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/terminal/route");
const appEnv = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/env-vars/route");
const orgEnv = await import("@/app/api/v1/organizations/[orgId]/env-vars/route");
const { registerGetEnvVars } = await import("@/lib/mcp/tools/get-env-vars");
const { encrypt } = await import("@/lib/crypto/encrypt");

const appParams = { params: Promise.resolve({ orgId: "org-1", appId: "app-1" }) };
const orgParams = { params: Promise.resolve({ orgId: "org-1" }) };
const base = "http://localhost/api/v1/organizations/org-1";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
let getEnvVars: Handler;
registerGetEnvVars(
  { tool: (_name: string, ...rest: unknown[]) => { getEnvVars = rest.at(-1) as Handler; } } as unknown as McpServer,
  { userId: "u1", organizationId: "org-1" } as McpAuthContext,
);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  dbMock.query.apps.findFirst.mockResolvedValue({
    id: "app-1",
    name: "web",
    status: "active",
    organizationId: "org-1",
    isSystemManaged: false,
    parentAppId: null,
    composeService: null,
    containerName: null,
    importedContainerId: null,
    parentApp: null,
    envContent: encrypt("TOKEN=s3cret", "org-1"),
  });
  dbMock.query.orgEnvVars.findMany.mockResolvedValue([
    { id: "v1", key: "TOKEN", value: encrypt("s3cret", "org-1"), isSecret: true },
  ]);
  dbMock.query.memberships.findFirst.mockImplementation(async () => ({ role: h.role }));
});

const openTerminal = () => terminal.GET(new NextRequest(`${base}/apps/app-1/terminal`), appParams);
const sendInput = () =>
  terminal.POST(
    new NextRequest(`${base}/apps/app-1/terminal`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "none", type: "input", data: "bHMK" }),
    }),
    appParams,
  );
const revealApp = () => appEnv.GET(new NextRequest(`${base}/apps/app-1/env-vars?reveal=true`), appParams);
const revealOrg = () => orgEnv.GET(new NextRequest(`${base}/env-vars?reveal=true`), orgParams);

describe("member session", () => {
  beforeEach(() => {
    h.role = "member";
  });

  it("is refused the terminal stream", async () => {
    expect((await openTerminal()).status).toBe(403);
  });

  it("is refused terminal input", async () => {
    expect((await sendInput()).status).toBe(403);
  });

  it("is refused the app env reveal", async () => {
    expect((await revealApp()).status).toBe(403);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("is refused the org env reveal", async () => {
    expect((await revealOrg()).status).toBe(403);
  });

  it("is refused the MCP env tool", async () => {
    const result = await getEnvVars({ appId: "app-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("s3cret");
  });

  it("still reads masked app and org env vars", async () => {
    const app = await appEnv.GET(new NextRequest(`${base}/apps/app-1/env-vars`), appParams);
    const org = await orgEnv.GET(new NextRequest(`${base}/env-vars`), orgParams);

    expect(await app.json()).toEqual({ content: "TOKEN=••••••••" });
    expect((await org.json()).envVars[0].value).toBe("••••••••");
  });
});

describe("admin session", () => {
  beforeEach(() => {
    h.role = "admin";
  });

  it("opens the terminal stream", async () => {
    expect((await openTerminal()).status).toBe(200);
  });

  it("reaches terminal input", async () => {
    expect((await sendInput()).status).toBe(404);
  });

  it("reveals app env vars and is audited", async () => {
    const res = await revealApp();

    expect(await res.json()).toEqual({ content: "TOKEN=s3cret" });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "app.env_revealed" }));
  });

  it("reveals org secrets and is audited", async () => {
    const res = await revealOrg();

    expect((await res.json()).envVars[0].value).toBe("s3cret");
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "org.env_revealed" }));
  });

  it("reads env vars through MCP", async () => {
    const result = await getEnvVars({ appId: "app-1" });

    expect(JSON.parse(result.content[0].text)).toEqual({ content: "TOKEN=s3cret" });
  });
});
