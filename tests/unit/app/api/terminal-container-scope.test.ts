// GET /api/v1/organizations/[orgId]/apps/[appId]/terminal
//
// A decomposed child carries the parent's vardo labels, so the lookup runs
// against the parent's stack and must narrow to the child's own compose service
// before anything is exec'd into.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, appsFindFirst, mockListContainers, mockCreateExec, mockStartExec } =
  vi.hoisted(() => ({
    mockVerifyOrgAccess: vi.fn(),
    appsFindFirst: vi.fn(),
    mockListContainers: vi.fn(),
    mockCreateExec: vi.fn(),
    mockStartExec: vi.fn(),
  }));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/docker/client", () => ({ listContainers: mockListContainers }));
vi.mock("@/lib/docker/exec", () => ({
  createExec: mockCreateExec,
  startExec: mockStartExec,
  resizeExec: vi.fn(),
}));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/db", () => ({ db: { query: { apps: { findFirst: appsFindFirst } } } }));

const { GET } = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/terminal/route");

const ORG_ID = "org-1";
const APP_ID = "child-server";
const params = { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID }) };

function request(query = "") {
  return new NextRequest(
    `http://localhost/api/v1/organizations/${ORG_ID}/apps/${APP_ID}/terminal${query}`,
  );
}

function container(id: string, service: string) {
  return {
    id,
    name: id,
    image: "img",
    state: "running",
    status: "Up 2 hours",
    ports: [],
    labels: {
      "vardo.project": "immich",
      "vardo.project.id": "parent-immich",
      "com.docker.compose.service": service,
    },
  };
}

const stack = [container("c-redis", "redis"), container("c-server", "server")];

const serverChild = {
  id: "child-server",
  name: "immich-server",
  status: "active",
  parentAppId: "parent-immich",
  composeService: "server",
  containerName: null,
  importedContainerId: null,
  parentApp: { name: "immich" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  appsFindFirst.mockResolvedValue(serverChild);
  mockListContainers.mockResolvedValue(stack);
  mockCreateExec.mockResolvedValue("exec-1");
  mockStartExec.mockResolvedValue({ on: vi.fn(), destroy: vi.fn(), destroyed: false });
});

describe("GET terminal — stack child container scope", () => {
  it("execs into the child's own service, not the first container in the stack", async () => {
    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    expect(mockListContainers).toHaveBeenCalledWith({ id: "parent-immich", name: "immich" });
    expect(mockCreateExec).toHaveBeenCalledWith("c-server", ["/bin/sh"]);
  });

  it("refuses a sibling's container id", async () => {
    const res = await GET(request("?container=c-redis"), params);

    expect(res.status).toBe(400);
    expect(mockCreateExec).not.toHaveBeenCalled();
  });

  it("still execs into a non-decomposed app's own container", async () => {
    appsFindFirst.mockResolvedValue({
      id: "app-1",
      name: "paperless",
      status: "active",
      parentAppId: null,
      composeService: null,
      containerName: null,
      importedContainerId: null,
      parentApp: null,
    });
    mockListContainers.mockResolvedValue([
      { ...container("c-mine", "app"), labels: { "vardo.project.id": "app-1" } },
    ]);

    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    expect(mockListContainers).toHaveBeenCalledWith({ id: "app-1", name: "paperless" });
    expect(mockCreateExec).toHaveBeenCalledWith("c-mine", ["/bin/sh"]);
  });
});
