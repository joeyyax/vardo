import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// A cross-org token must not import admin rights across an org boundary
// ---------------------------------------------------------------------------
// Restoring a GPU-passthrough snapshot is owner/admin only. The role that
// counts is the one held in the app's own org, not the token's home org.
//
// Under test: lib/mcp/tools/rollback-app.ts

const appFindFirst = vi.fn();
const environmentFindFirst = vi.fn();
const deploymentFindFirst = vi.fn();
const membershipFindFirst = vi.fn();
const createDeployment = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => appFindFirst(...a) },
      environments: { findFirst: (...a: unknown[]) => environmentFindFirst(...a) },
      deployments: { findFirst: (...a: unknown[]) => deploymentFindFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: (...a: unknown[]) => createDeployment(...a),
}));

vi.mock("@/lib/docker/deploy-cancel", () => ({
  requestDeploy: async () => ({ success: true }),
}));

vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: async () => ({ limited: false }),
}));

const HOME = "org-ops";
const OTHER = "org-vardo";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function rollback(crossOrg: boolean): Promise<Handler> {
  const { registerRollbackApp } = await import("@/lib/mcp/tools/rollback-app");
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
      captured = fn;
    },
  };
  registerRollbackApp(server as never, {
    userId: "u1",
    organizationId: HOME,
    crossOrg,
  } as never);
  return captured!;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  createDeployment.mockResolvedValue("dep-new");
  appFindFirst.mockResolvedValue({ id: "a1", name: "vardo", organizationId: OTHER });
  environmentFindFirst.mockResolvedValue({ type: "production" });
  deploymentFindFirst.mockResolvedValue({
    id: "dep-old",
    status: "success",
    gitSha: "abc",
    gitMessage: "old",
    configSnapshot: { gpuEnabled: true },
  });
});

describe("GPU rollback in a widened org", () => {
  const args = { appId: "a1", deploymentId: "dep-old", includeEnvVars: false };

  it("refuses when the user is only a plain member of the app's org", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "member" });

    const res = await (await rollback(true))(args);

    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/Only owners and admins/);
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("allows it when the user is an owner of the app's org", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "owner" });

    const res = await (await rollback(true))(args);

    expect(res.isError).toBeFalsy();
    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: OTHER })
    );
  });

  it("refuses outright without a cross-org flag", async () => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "owner" });

    const res = await (await rollback(false))(args);

    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/not found or access denied/);
  });
});

describe("restoring env vars through a rollback", () => {
  async function rollbackWithScope(scope: "deploy" | "full"): Promise<Handler> {
    const { registerRollbackApp } = await import("@/lib/mcp/tools/rollback-app");
    const { tokenScopeCapabilities } = await import("@/lib/auth/permissions");
    let captured: Handler | undefined;
    const server = {
      tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
        captured = fn;
      },
    };
    registerRollbackApp(server as never, {
      userId: "u1",
      organizationId: OTHER,
      crossOrg: false,
      scopes: tokenScopeCapabilities(scope, null),
    } as never);
    return captured!;
  }

  beforeEach(() => {
    membershipFindFirst.mockResolvedValue({ id: "m1", role: "owner" });
    deploymentFindFirst.mockResolvedValue({ id: "dep-old", status: "success", gitSha: "abc", gitMessage: "old", configSnapshot: {} });
  });

  it("refuses a deploy-scoped token", async () => {
    const res = await (await rollbackWithScope("deploy"))({ appId: "a1", deploymentId: "dep-old", includeEnvVars: true });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/permission to change them/);
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("still lets a deploy-scoped token roll back without env vars", async () => {
    const res = await (await rollbackWithScope("deploy"))({ appId: "a1", deploymentId: "dep-old", includeEnvVars: false });
    expect(res.isError).toBeFalsy();
  });

  it("allows a token that may write env vars", async () => {
    const res = await (await rollbackWithScope("full"))({ appId: "a1", deploymentId: "dep-old", includeEnvVars: true });
    expect(res.isError).toBeFalsy();
  });
});
