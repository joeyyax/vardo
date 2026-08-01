import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/[orgId]/stats/business
// ---------------------------------------------------------------------------
// Guards the org scoping of business metrics. The global series
// (metrics:business:<metric>) counts every org on the instance and must never
// be reachable from an org-scoped endpoint.

const {
  mockVerifyOrgAccess,
  mockQueryOrg,
  mockGetLatestOrg,
  mockQueryGlobal,
  mockGetLatestGlobal,
} = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockQueryOrg: vi.fn(),
  mockGetLatestOrg: vi.fn(),
  mockQueryGlobal: vi.fn(),
  mockGetLatestGlobal: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: mockVerifyOrgAccess,
}));

vi.mock("@/lib/metrics/store", () => ({
  queryOrgBusinessMetric: mockQueryOrg,
  getLatestOrgBusinessMetric: mockGetLatestOrg,
  queryBusinessMetric: mockQueryGlobal,
  getLatestBusinessMetric: mockGetLatestGlobal,
}));

const { GET } = await import("@/app/api/v1/organizations/[orgId]/stats/business/route");

const ORG_ID = "org-abc";
const params = { params: Promise.resolve({ orgId: ORG_ID }) };

function request(query = "") {
  return new NextRequest(
    `http://localhost/api/v1/organizations/${ORG_ID}/stats/business${query}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyOrgAccess.mockResolvedValue({ organization: { id: ORG_ID } });
  mockQueryOrg.mockResolvedValue([]);
  mockGetLatestOrg.mockResolvedValue({ timestamp: 1, value: 3 });
});

describe("GET /stats/business — org scoping", () => {
  it("reads latest values from the org series", async () => {
    const res = await GET(request(), params);

    expect(res.status).toBe(200);
    expect(mockGetLatestOrg).toHaveBeenCalled();
    for (const call of mockGetLatestOrg.mock.calls) {
      expect(call[0]).toBe(ORG_ID);
    }
    expect(mockGetLatestGlobal).not.toHaveBeenCalled();
  });

  it("reads history from the org series", async () => {
    const res = await GET(request("?from=0&to=1000"), params);

    expect(res.status).toBe(200);
    expect(mockQueryOrg).toHaveBeenCalled();
    for (const call of mockQueryOrg.mock.calls) {
      expect(call[0]).toBe(ORG_ID);
    }
    expect(mockQueryGlobal).not.toHaveBeenCalled();
  });

  it("rejects the instance-wide organizations metric", async () => {
    await GET(request("?metrics=organizations"), params);

    const requested = mockGetLatestOrg.mock.calls.map((c) => c[1]);
    expect(requested).not.toContain("organizations");
  });

  it("returns 403 for a non-member", async () => {
    mockVerifyOrgAccess.mockResolvedValue(null);

    const res = await GET(request(), params);

    expect(res.status).toBe(403);
    expect(mockGetLatestOrg).not.toHaveBeenCalled();
  });
});
