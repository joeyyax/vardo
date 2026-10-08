// Container discovery and import under /api/v1/organizations/[orgId]/discover
//
// Discovery lists every unmanaged container on the host and returns its env,
// so it is instance-admin only. Org role does not count.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, mockSession, mockDiscover, mockDetail } = vi.hoisted(
  () => ({
    mockVerifyOrgAccess: vi.fn(),
    mockSession: vi.fn(),
    mockDiscover: vi.fn(),
    mockDetail: vi.fn(),
  }),
);

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/session", () => ({
  getSession: mockSession,
  requireSession: async () => {
    const s = await mockSession();
    if (!s) throw new Error("Unauthorized");
    return s;
  },
}));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/docker/discover", () => ({
  discoverContainers: mockDiscover,
  getContainerDetail: mockDetail,
  hasAtFileTraefikLabels: vi.fn(),
  isLocalImage: vi.fn(),
}));

const list = await import("@/app/api/v1/organizations/[orgId]/discover/containers/route");
const detail = await import("@/app/api/v1/organizations/[orgId]/discover/containers/[containerId]/route");
const importOne = await import(
  "@/app/api/v1/organizations/[orgId]/discover/containers/[containerId]/import/route"
);
const importGroup = await import(
  "@/app/api/v1/organizations/[orgId]/discover/groups/[composeProject]/import/route"
);

const ORG_ID = "org-1";
const CONTAINER_ID = "abcdef012345";

function req(method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/organizations/${ORG_ID}/discover`, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

function as(role: string, instanceAdmin: boolean, authMethod: "session" | "token" = "session") {
  const session = { user: { id: "u1" }, authMethod };
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: ORG_ID },
    membership: { role },
    session,
  });
  mockSession.mockResolvedValue(session);
  dbMock.query.user.findFirst.mockResolvedValue({ isAppAdmin: instanceAdmin });
}

const calls = {
  list: () => list.GET(req(), { params: Promise.resolve({ orgId: ORG_ID }) }),
  detail: () =>
    detail.GET(req(), { params: Promise.resolve({ orgId: ORG_ID, containerId: CONTAINER_ID }) }),
  importOne: () =>
    importOne.POST(req("POST", {}), {
      params: Promise.resolve({ orgId: ORG_ID, containerId: CONTAINER_ID }),
    }),
  importGroup: () =>
    importGroup.POST(req("POST", {}), {
      params: Promise.resolve({ orgId: ORG_ID, composeProject: "stack" }),
    }),
};

beforeEach(() => {
  dbMock.reset();
  vi.clearAllMocks();
  mockDiscover.mockResolvedValue({ standalone: [], groups: [] });
  mockDetail.mockResolvedValue({ id: CONTAINER_ID, env: { SECRET: "x" } });
});

describe.each(Object.entries(calls))("discover %s", (_name, call) => {
  it("denies an org member", async () => {
    as("member", false);
    expect((await call()).status).toBe(403);
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it("denies an org owner who is not an instance admin", async () => {
    as("owner", false);
    expect((await call()).status).toBe(403);
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it("denies an instance admin's API token", async () => {
    as("owner", true, "token");
    expect((await call()).status).toBe(403);
  });

  it("lets an instance admin through", async () => {
    as("member", true);
    expect((await call()).status).not.toBe(403);
  });
});
