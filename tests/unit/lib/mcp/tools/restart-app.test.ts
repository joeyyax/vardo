import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const membershipFindFirst = vi.fn();
const restartContainers = vi.fn();
const resolveDefaultEnv = vi.fn();
const reconcileAppNow = vi.fn();
const recordLifecycle = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => findFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
  },
}));
vi.mock("@/lib/docker/deploy", () => ({
  restartContainers: (...a: unknown[]) => restartContainers(...a),
  createDeployment: vi.fn(),
}));
vi.mock("@/lib/docker/resolve-env", () => ({
  resolveDefaultEnv: (...a: unknown[]) => resolveDefaultEnv(...a),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: async () => ({ limited: false }),
}));
vi.mock("@/lib/docker/status-reconcile", () => ({
  reconcileAppNow: (...a: unknown[]) => reconcileAppNow(...a),
}));
vi.mock("@/lib/activity/lifecycle", () => ({
  recordLifecycle: (...a: unknown[]) => recordLifecycle(...a),
}));

type Handler = (args: { appId: string }) => Promise<{ content: { text: string }[] }>;

async function handler(): Promise<Handler> {
  const { registerRestartApp } = await import("@/lib/mcp/tools/restart-app");
  let captured: Handler | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, fn: Handler) => {
      captured = fn;
    },
  };
  registerRestartApp(server as never, {
    userId: "u1",
    organizationId: "org1",
    crossOrg: false,
  } as never);
  return captured!;
}

beforeEach(() => {
  vi.clearAllMocks();
  restartContainers.mockResolvedValue({ success: true, log: "ok" });
  membershipFindFirst.mockResolvedValue({ id: "m1" });
});

describe("vardo_restart_app — environment scoping", () => {
  it("restarts a standalone app in its default environment", async () => {
    findFirst.mockResolvedValueOnce({
      id: "a1",
      name: "paperless",
      status: "active",
      organizationId: "org1",
      parentAppId: null,
      composeService: null,
    });
    resolveDefaultEnv.mockResolvedValueOnce({ name: "staging", type: "staging", id: "e1" });

    await (await handler())({ appId: "a1" });

    expect(resolveDefaultEnv).toHaveBeenCalledWith("a1");
    expect(restartContainers).toHaveBeenCalledWith("paperless", "staging", undefined);
  });

  it("refreshes the row and records the restart once it went through", async () => {
    findFirst.mockResolvedValueOnce({
      id: "a1",
      name: "paperless",
      status: "active",
      organizationId: "org1",
      parentAppId: null,
      composeService: null,
    });
    resolveDefaultEnv.mockResolvedValueOnce({ name: "production", type: "production", id: "e1" });

    await (await handler())({ appId: "a1" });

    expect(reconcileAppNow).toHaveBeenCalledWith("a1");
    expect(recordLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "restarted", trigger: "mcp", userId: "u1" }),
    );
  });

  it("leaves both alone when the restart failed", async () => {
    findFirst.mockResolvedValueOnce({
      id: "a1",
      name: "paperless",
      status: "active",
      organizationId: "org1",
      parentAppId: null,
      composeService: null,
    });
    resolveDefaultEnv.mockResolvedValueOnce({ name: "production", type: "production", id: "e1" });
    restartContainers.mockResolvedValueOnce({ success: false, log: "boom" });

    await (await handler())({ appId: "a1" });

    expect(reconcileAppNow).not.toHaveBeenCalled();
    expect(recordLifecycle).not.toHaveBeenCalled();
  });

  it("restarts a compose child using the parent's project and environment", async () => {
    findFirst
      .mockResolvedValueOnce({
        id: "c1",
        name: "paperless-db",
        status: "active",
        organizationId: "org1",
        parentAppId: "a1",
        composeService: "db",
      })
      .mockResolvedValueOnce({ id: "a1", name: "paperless" });
    resolveDefaultEnv.mockResolvedValueOnce({ name: "staging", type: "staging", id: "e1" });

    await (await handler())({ appId: "c1" });

    expect(resolveDefaultEnv).toHaveBeenCalledWith("a1");
    expect(restartContainers).toHaveBeenCalledWith("paperless", "staging", "db");
  });
});
