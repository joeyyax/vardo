// GET /api/v1/sse
//
// The unified gateway replaced per-org notification streams but dropped the
// membership guard, so any session could name any org and read its event bus.
// The `deploy` param was equally unchecked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetSession, mockVerifyOrgAccess, mockStartGateway, deploymentsFindFirst } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockVerifyOrgAccess: vi.fn(),
    mockStartGateway: vi.fn(),
    deploymentsFindFirst: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/sse/gateway", () => ({ startGateway: mockStartGateway }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/db", () => ({
  db: { query: { deployments: { findFirst: deploymentsFindFirst } } },
}));

const { GET } = await import("@/app/api/v1/sse/route");

const ORG_ID = "org-1";
const OTHER_ORG = "org-2";

function request(query: string) {
  return new NextRequest(`http://localhost/api/v1/sse?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockVerifyOrgAccess.mockImplementation(async (orgId: string) =>
    orgId === ORG_ID ? { organization: { id: ORG_ID } } : null,
  );
  deploymentsFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/v1/sse — org access", () => {
  it("rejects an org the caller does not belong to", async () => {
    const res = await GET(request(`org=${OTHER_ORG}`));

    expect(res.status).toBe(403);
    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it("still requires a session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await GET(request(`org=${ORG_ID}`));

    expect(res.status).toBe(401);
    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it("streams for a member of the org", async () => {
    vi.useFakeTimers();

    const res = await GET(request(`org=${ORG_ID}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(mockStartGateway).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, userId: "user-1" }),
      expect.any(Function),
    );

    vi.clearAllTimers();
  });
});

describe("GET /api/v1/sse — deploy log access", () => {
  it("rejects a deploy belonging to another org", async () => {
    deploymentsFindFirst.mockResolvedValue({
      id: "deploy-x",
      app: { organizationId: OTHER_ORG },
    });

    const res = await GET(request(`org=${ORG_ID}&deploy=deploy-x`));

    expect(res.status).toBe(404);
    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it("rejects a deploy that does not exist", async () => {
    deploymentsFindFirst.mockResolvedValue(undefined);

    const res = await GET(request(`org=${ORG_ID}&deploy=nope`));

    expect(res.status).toBe(404);
    expect(mockStartGateway).not.toHaveBeenCalled();
  });

  it("streams a deploy owned by the caller's org", async () => {
    vi.useFakeTimers();
    deploymentsFindFirst.mockResolvedValue({
      id: "deploy-1",
      app: { organizationId: ORG_ID },
    });

    const res = await GET(request(`org=${ORG_ID}&deploy=deploy-1`));

    expect(res.status).toBe(200);
    expect(mockStartGateway).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, deployId: "deploy-1" }),
      expect.any(Function),
    );

    vi.clearAllTimers();
  });
});
