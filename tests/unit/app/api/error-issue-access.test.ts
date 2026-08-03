// GET /api/v1/organizations/[orgId]/apps/[appId]/errors/[issueId]
//
// The route verified the org and then ignored appId entirely. GlitchTip issue
// ids are sequential integers, so any app's latest event — stack traces and
// request data — was enumerable from any org the caller belonged to.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockVerifyOrgAccess,
  mockIsFeatureEnabledAsync,
  mockGetIssueProjectSlug,
  mockGetIssueLatestEvent,
  appsFindFirst,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockIsFeatureEnabledAsync: vi.fn(),
  mockGetIssueProjectSlug: vi.fn(),
  mockGetIssueLatestEvent: vi.fn(),
  appsFindFirst: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: mockIsFeatureEnabledAsync }));
vi.mock("@/lib/error-tracking/client", () => ({
  getIssueProjectSlug: mockGetIssueProjectSlug,
  getIssueLatestEvent: mockGetIssueLatestEvent,
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findFirst: appsFindFirst } } },
}));

const { GET } = await import(
  "@/app/api/v1/organizations/[orgId]/apps/[appId]/errors/[issueId]/route"
);

const ORG_ID = "org-1";
const APP_ID = "app-a";
const EVENT = { eventID: "e1", title: "boom", message: "", dateCreated: "", tags: [], entries: [] };

function params(issueId: string) {
  return { params: Promise.resolve({ orgId: ORG_ID, appId: APP_ID, issueId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  mockIsFeatureEnabledAsync.mockResolvedValue(true);
  appsFindFirst.mockResolvedValue({ id: APP_ID, name: "app-a" });
  mockGetIssueProjectSlug.mockResolvedValue("app-a");
  mockGetIssueLatestEvent.mockResolvedValue(EVENT);
});

describe("GET errors/[issueId] — issue ownership", () => {
  it("rejects an issue that belongs to another app's project", async () => {
    mockGetIssueProjectSlug.mockResolvedValue("someone-elses-app");

    const res = await GET(new Request("http://localhost"), params("4242"));

    expect(res.status).toBe(404);
    expect(mockGetIssueLatestEvent).not.toHaveBeenCalled();
  });

  it("rejects when the issue's project cannot be resolved", async () => {
    mockGetIssueProjectSlug.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost"), params("4242"));

    expect(res.status).toBe(404);
    expect(mockGetIssueLatestEvent).not.toHaveBeenCalled();
  });

  it("rejects an app that is not in the verified org", async () => {
    appsFindFirst.mockResolvedValue(undefined);

    const res = await GET(new Request("http://localhost"), params("4242"));

    expect(res.status).toBe(404);
    expect(mockGetIssueLatestEvent).not.toHaveBeenCalled();
  });

  it("returns the event for an issue in the app's own project", async () => {
    const res = await GET(new Request("http://localhost"), params("4242"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: EVENT });
    expect(mockGetIssueLatestEvent).toHaveBeenCalledWith(4242);
  });
});
