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
  projectsFindFirst,
  projectsFindMany,
  mockInsert,
  mockUpdate,
  mockDelete,
  insertValues,
  conflictUpdate,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockVerifyOrgAccess: vi.fn(),
  channelsFindMany: vi.fn(),
  prefsFindMany: vi.fn(),
  prefsFindFirst: vi.fn(),
  digestFindFirst: vi.fn(),
  channelsFindFirst: vi.fn(),
  projectsFindFirst: vi.fn(),
  projectsFindMany: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  insertValues: vi.fn(),
  conflictUpdate: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mockRequireSession, isScopedToken: () => false }));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => {
  const watchRows = { from: () => watchRows, innerJoin: () => watchRows, where: async () => [{ projectId: "proj-1" }] };
  return {
    db: {
      query: {
        notificationChannels: { findMany: channelsFindMany, findFirst: channelsFindFirst },
        userNotificationPreferences: { findMany: prefsFindMany, findFirst: prefsFindFirst },
        userDigestPreferences: { findFirst: digestFindFirst },
        projects: { findFirst: projectsFindFirst, findMany: projectsFindMany },
      },
      select: () => watchRows,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
    },
  };
});

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
  projectsFindMany.mockResolvedValue([{ id: "proj-1", name: "mowp", displayName: "MOWP" }]);
  projectsFindFirst.mockResolvedValue(null);
  // The channel genuinely exists in the foreign org — only membership stops the write.
  channelsFindFirst.mockResolvedValue({ id: "chan-x" });
  const chain = { onConflictDoUpdate: conflictUpdate.mockResolvedValue(undefined), onConflictDoNothing: vi.fn().mockResolvedValue(undefined), then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r) };
  mockInsert.mockReturnValue({ values: insertValues.mockReturnValue(chain) });
  mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
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

  it("returns channels, the weekly default, projects and watches for the caller's own org", async () => {
    const res = await GET(getRequest(ORG_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toHaveLength(1);
    expect(body.digestFrequency).toBe("weekly");
    expect(body.projects).toEqual([{ id: "proj-1", name: "MOWP" }]);
    expect(body.watching).toEqual(["proj-1"]);
  });

  it("returns a stored frequency", async () => {
    digestFindFirst.mockResolvedValue({ frequency: "off" });
    const body = await (await GET(getRequest(ORG_ID))).json();
    expect(body.digestFrequency).toBe("off");
  });
});

describe("PUT notification-preferences — org membership", () => {
  it("rejects a digest write scoped to a foreign org", async () => {
    const res = await PUT(putRequest({ type: "digest", orgId: OTHER_ORG, frequency: "monthly" }), undefined);

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

  it("accepts a digest frequency for the caller's own org", async () => {
    const res = await PUT(putRequest({ type: "digest", orgId: ORG_ID, frequency: "monthly" }), undefined);

    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", organizationId: ORG_ID, frequency: "monthly" }));
    expect(conflictUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ frequency: "monthly" }) }));
  });
});

describe("PUT notification-preferences — validation", () => {
  it.each([
    ["an unknown frequency", { type: "digest", orgId: ORG_ID, frequency: "daily" }],
    ["the old toggle", { type: "digest", orgId: ORG_ID, digestEnabled: true }],
    ["a watch without a project", { type: "watch", orgId: ORG_ID, watching: true }],
    ["a watch flag that isn't a boolean", { type: "watch", orgId: ORG_ID, projectId: "proj-1", watching: "yes" }],
  ])("rejects %s", async (_label, body) => {
    const res = await PUT(putRequest(body), undefined);
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("PUT notification-preferences — watching", () => {
  it("refuses a project outside the org", async () => {
    const res = await PUT(putRequest({ type: "watch", orgId: ORG_ID, projectId: "proj-foreign", watching: true }), undefined);
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("watches and unwatches a project in the org", async () => {
    projectsFindFirst.mockResolvedValue({ id: "proj-1" });
    expect((await PUT(putRequest({ type: "watch", orgId: ORG_ID, projectId: "proj-1", watching: true }), undefined)).status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith({ userId: "user-1", projectId: "proj-1" });

    expect((await PUT(putRequest({ type: "watch", orgId: ORG_ID, projectId: "proj-1", watching: false }), undefined)).status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });
});
