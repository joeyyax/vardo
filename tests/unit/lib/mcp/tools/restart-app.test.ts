// vardo_restart_app shares startOrRestartApp with the HTTP route
// (tests/unit/lib/docker/start-app.test.ts covers which command each status
// earns). What is only true here is the deploy fall-through when there is
// nothing on disk to bring up.

import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const membershipFindFirst = vi.fn();
const startOrRestartApp = vi.fn();
const createDeployment = vi.fn();
const requestDeploy = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: (...a: unknown[]) => findFirst(...a) },
      memberships: { findFirst: (...a: unknown[]) => membershipFindFirst(...a) },
    },
  },
}));
vi.mock("@/lib/docker/deploy", () => ({
  createDeployment: (...a: unknown[]) => createDeployment(...a),
}));
vi.mock("@/lib/docker/deploy-cancel", () => ({
  requestDeploy: (...a: unknown[]) => requestDeploy(...a),
}));
vi.mock("@/lib/docker/start-app", () => ({
  startOrRestartApp: (...a: unknown[]) => startOrRestartApp(...a),
}));
vi.mock("@/lib/api/rate-limit", () => ({
  slidingWindowRateLimit: async () => ({ limited: false }),
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

async function call(appId = "a1") {
  const res = await (await handler())({ appId });
  return JSON.parse(res.content[0].text);
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    name: "paperless",
    status: "active",
    organizationId: "org1",
    parentAppId: null,
    composeService: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipFindFirst.mockResolvedValue({ id: "m1" });
  createDeployment.mockResolvedValue("dep-1");
  requestDeploy.mockResolvedValue(undefined);
  startOrRestartApp.mockResolvedValue({
    success: true,
    action: "restarted",
    log: "ok",
    observed: "active",
  });
});

describe("vardo_restart_app", () => {
  it("reports what the shared start path did", async () => {
    findFirst.mockResolvedValueOnce(app());

    const out = await call();

    expect(startOrRestartApp).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", userId: "u1", trigger: "mcp" }),
    );
    expect(out).toMatchObject({ action: "restarted", status: "active" });
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("names a start a start", async () => {
    findFirst.mockResolvedValueOnce(app({ status: "stopped" }));
    startOrRestartApp.mockResolvedValue({
      success: true,
      action: "started",
      log: "",
      observed: "active",
    });

    expect(await call()).toMatchObject({ action: "started" });
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it("deploys only when there is nothing on disk to bring up", async () => {
    findFirst.mockResolvedValueOnce(app({ status: "stopped" }));
    startOrRestartApp.mockResolvedValue({ success: false, action: "none", failure: "no-slot", log: "" });

    const out = await call();

    expect(createDeployment).toHaveBeenCalledWith(expect.objectContaining({ appId: "a1" }));
    expect(out).toMatchObject({ action: "deployed", deploymentId: "dep-1", deployedParent: false });
  });

  it("deploys the parent when the child has nothing on disk", async () => {
    findFirst.mockResolvedValueOnce(
      app({ id: "c1", name: "paperless-db", status: "stopped", parentAppId: "a1", composeService: "db" }),
    );
    startOrRestartApp.mockResolvedValue({ success: false, action: "none", failure: "no-slot", log: "" });

    const out = await call("c1");

    expect(createDeployment).toHaveBeenCalledWith(expect.objectContaining({ appId: "a1" }));
    expect(out).toMatchObject({ deployTargetId: "a1", deployedParent: true });
  });

  it("surfaces a compose failure instead of deploying over it", async () => {
    findFirst.mockResolvedValueOnce(app());
    startOrRestartApp.mockResolvedValue({
      success: false,
      action: "none",
      failure: "compose",
      log: "ERROR: boom",
    });

    const out = await call();

    expect(createDeployment).not.toHaveBeenCalled();
    expect(out).toMatchObject({ error: "ERROR: boom" });
  });
});
