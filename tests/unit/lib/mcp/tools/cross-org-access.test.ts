import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Cross-org token scope, end to end through a read tool and a write tool
// ---------------------------------------------------------------------------
// Under test: lib/mcp/tools/get-app-status.ts, lib/mcp/tools/set-env-vars.ts

const appFindFirst = vi.fn();
const membershipFindFirst = vi.fn();
const updateSet = vi.fn();
const updateWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => appFindFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
    update: () => ({
      set: (...a: unknown[]) => {
        updateSet(...a);
        return { where: (...w: unknown[]) => updateWhere(...w) };
      },
    }),
  },
}));

vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: async () => ({ limited: false }),
}));

vi.mock("@/lib/crypto/encrypt", () => ({
  encrypt: (content: string, orgId: string) => `enc(${orgId}):${content}`,
}));

const HOME = "org-homelab";
const OTHER = "org-vardo";

const normalToken = { userId: "u1", organizationId: HOME, crossOrg: false };
const crossToken = { userId: "u1", organizationId: HOME, crossOrg: true };

type Ctx = { userId: string; organizationId: string; crossOrg: boolean };
type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function toolHandler(
  register: (server: never, ctx: never) => void,
  context: Ctx
): Promise<Handler> {
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
      captured = fn;
    },
  };
  register(server as never, context as never);
  return captured!;
}

async function getAppStatus(context: Ctx) {
  const { registerGetAppStatus } = await import("@/lib/mcp/tools/get-app-status");
  return toolHandler(registerGetAppStatus, context);
}

async function setEnvVars(context: Ctx) {
  const { registerSetEnvVars } = await import("@/lib/mcp/tools/set-env-vars");
  return toolHandler(registerSetEnvVars, context);
}

// The only org ever looked up is the staged app's, so the membership mock can
// answer from these two without parsing the drizzle where clause.
let stagedOrg = "";
let memberOrgs: string[] = [];

/** The user is a member of every org in `orgIds`, and no others. */
function memberOf(orgIds: string[]) {
  memberOrgs = orgIds;
}

function stageApp(organizationId: string) {
  stagedOrg = organizationId;
  appFindFirst.mockResolvedValue({
    id: "a1",
    name: "vardo",
    organizationId,
    isSystemManaged: false,
    envContent: null,
  });
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  stagedOrg = "";
  memberOrgs = [];
  membershipFindFirst.mockImplementation(async () =>
    memberOrgs.includes(stagedOrg) ? { id: "m1", role: "owner" } : undefined
  );
});

describe("read path — vardo_get_app_status", () => {
  it("a normal token reaches an app in its own org", async () => {
    stageApp(HOME);
    memberOf([HOME, OTHER]);

    const res = await (await getAppStatus(normalToken))({ appId: "a1" });

    expect(res.isError).toBeFalsy();
    expect(parse(res).app.id).toBe("a1");
  });

  it("a normal token cannot reach another org, even one its user belongs to", async () => {
    stageApp(OTHER);
    memberOf([HOME, OTHER]);

    const res = await (await getAppStatus(normalToken))({ appId: "a1" });

    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found or access denied/);
  });

  it("a cross-org token reaches an app in an org its user belongs to", async () => {
    stageApp(OTHER);
    memberOf([HOME, OTHER]);

    const res = await (await getAppStatus(crossToken))({ appId: "a1" });

    expect(res.isError).toBeFalsy();
    expect(parse(res).app.id).toBe("a1");
  });

  it("a cross-org token cannot reach an org its user does not belong to", async () => {
    stageApp("org-someone-else");
    memberOf([HOME, OTHER]);

    const res = await (await getAppStatus(crossToken))({ appId: "a1" });

    expect(res.isError).toBe(true);
  });

  it("revoking the membership revokes access on the next request", async () => {
    stageApp(OTHER);
    memberOf([HOME, OTHER]);
    expect((await (await getAppStatus(crossToken))({ appId: "a1" })).isError).toBeFalsy();

    memberOf([HOME]);
    expect((await (await getAppStatus(crossToken))({ appId: "a1" })).isError).toBe(true);
  });
});

describe("write path — vardo_set_env_vars", () => {
  it("a normal token cannot write to another org's app", async () => {
    stageApp(OTHER);
    memberOf([HOME, OTHER]);

    const res = await (await setEnvVars(normalToken))({
      appId: "a1",
      content: "KEY=value",
    });

    expect(res.isError).toBe(true);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("a cross-org token writes using the target org's encryption context", async () => {
    stageApp(OTHER);
    memberOf([HOME, OTHER]);

    const res = await (await setEnvVars(crossToken))({
      appId: "a1",
      content: "KEY=value",
    });

    expect(res.isError).toBeFalsy();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ envContent: `enc(${OTHER}):KEY=value` })
    );
  });

  it("a cross-org token cannot write to an org its user does not belong to", async () => {
    stageApp("org-someone-else");
    memberOf([HOME, OTHER]);

    const res = await (await setEnvVars(crossToken))({
      appId: "a1",
      content: "KEY=value",
    });

    expect(res.isError).toBe(true);
    expect(updateSet).not.toHaveBeenCalled();
  });
});
