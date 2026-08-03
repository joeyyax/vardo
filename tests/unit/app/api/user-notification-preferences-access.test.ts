// GET/PUT /api/v1/user/notification-preferences
//
// orgId came straight off the query string / body with no membership check, so
// any session could list another org's notification channels and write
// preference rows scoped to it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockRequireSession,
  mockVerifyOrgAccess,
  channelsFindMany,
  prefsFindMany,
  prefsFindFirst,
  digestFindFirst,
  channelsFindFirst,
  mockInsert,
  mockUpdate,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockVerifyOrgAccess: vi.fn(),
  channelsFindMany: vi.fn(),
  prefsFindMany: vi.fn(),
  prefsFindFirst: vi.fn(),
  digestFindFirst: vi.fn(),
  channelsFindFirst: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mockRequireSession }));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      notificationChannels: { findMany: channelsFindMany, findFirst: channelsFindFirst },
      userNotificationPreferences: { findMany: prefsFindMany, findFirst: prefsFindFirst },
      userDigestPreferences: { findFirst: digestFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
}));

const { GET, PUT } = await import("@/app/api/v1/user/notification-preferences/route");

const ORG_ID = "org-1";
const OTHER_ORG = "org-2";

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
  mockVerifyOrgAccess.mockImplementation(async (orgId: string) =>
    orgId === ORG_ID ? { organization: { id: ORG_ID }, session: { user: { id: "user-1" } } } : null,
  );
  channelsFindMany.mockResolvedValue([{ id: "chan-1", name: "Ops", type: "email", enabled: true }]);
  prefsFindMany.mockResolvedValue([]);
  digestFindFirst.mockResolvedValue(null);
  prefsFindFirst.mockResolvedValue(null);
  // The channel genuinely exists in the foreign org — only membership stops the write.
  channelsFindFirst.mockResolvedValue({ id: "chan-x" });
  mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
});

function getRequest(orgId: string) {
  return new NextRequest(
    `http://localhost/api/v1/user/notification-preferences?orgId=${orgId}`,
  );
}

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/v1/user/notification-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET notification-preferences — org membership", () => {
  it("does not list channels for an org the caller is not in", async () => {
    const res = await GET(getRequest(OTHER_ORG));

    expect(res.status).toBe(403);
    expect(channelsFindMany).not.toHaveBeenCalled();
  });

  it("returns channels for the caller's own org", async () => {
    const res = await GET(getRequest(ORG_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toHaveLength(1);
  });
});

describe("PUT notification-preferences — org membership", () => {
  it("rejects a digest write scoped to a foreign org", async () => {
    const res = await PUT(
      putRequest({ type: "digest", orgId: OTHER_ORG, digestEnabled: true }),
      undefined,
    );

    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a preference write scoped to a foreign org", async () => {
    const res = await PUT(
      putRequest({
        type: "preference",
        orgId: OTHER_ORG,
        channelId: "chan-x",
        eventType: "deploy.success",
        enabled: true,
      }),
      undefined,
    );

    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a digest write for the caller's own org", async () => {
    const res = await PUT(
      putRequest({ type: "digest", orgId: ORG_ID, digestEnabled: true }),
      undefined,
    );

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalled();
  });
});
