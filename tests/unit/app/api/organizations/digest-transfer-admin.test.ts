// PATCH /api/v1/organizations/[orgId]/digest
// DELETE /api/v1/organizations/[orgId]/apps/[appId]/transfer
//
// Both match their admin-gated siblings: digest POST and transfer POST.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifyOrgAccess, upsert, rejectTransfer, transfersFindFirst } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  upsert: vi.fn(),
  rejectTransfer: vi.fn(),
  transfersFindFirst: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", async () => {
  const { gateOrgAccess } = await import("../../../helpers/verify-access");
  return { verifyOrgAccess: gateOrgAccess(mockVerifyOrgAccess) };
});
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/digest/collector", () => ({ collectDigestData: vi.fn() }));
vi.mock("@/lib/notifications/factory", () => ({ createChannel: vi.fn() }));
vi.mock("@/lib/transfers/engine", () => ({
  initiateTransfer: vi.fn(),
  analyzeTransfer: vi.fn(),
  rejectTransfer,
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: { appTransfers: { findFirst: transfersFindFirst } },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            upsert();
            return [{ enabled: true, dayOfWeek: 1, hourOfDay: 8, lastSentAt: null }];
          },
        }),
      }),
    }),
  },
}));

const digest = await import("@/app/api/v1/organizations/[orgId]/digest/route");
const transfer = await import("@/app/api/v1/organizations/[orgId]/apps/[appId]/transfer/route");

function as(role: string) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: "o1" },
    membership: { role },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
}

const patchDigest = () =>
  digest.PATCH(
    new NextRequest("http://localhost/api/v1/organizations/o1/digest", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    }),
    { params: Promise.resolve({ orgId: "o1" }) },
  );

const cancelTransfer = () =>
  transfer.DELETE(
    new NextRequest("http://localhost/api/v1/organizations/o1/apps/a1/transfer", { method: "DELETE" }),
    { params: Promise.resolve({ orgId: "o1", appId: "a1" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  transfersFindFirst.mockResolvedValue({ id: "t1", initiatedBy: "u1" });
});

describe("digest PATCH", () => {
  it("refuses a member", async () => {
    as("member");
    expect((await patchDigest()).status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("lets an %s change it", async (role) => {
    as(role);
    expect((await patchDigest()).status).toBe(200);
    expect(upsert).toHaveBeenCalled();
  });
});

describe("transfer cancel", () => {
  it("refuses an initiator who is now a member", async () => {
    as("member");
    expect((await cancelTransfer()).status).toBe(403);
    expect(rejectTransfer).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner"])("lets an %s initiator cancel", async (role) => {
    as(role);
    expect((await cancelTransfer()).status).toBe(200);
    expect(rejectTransfer).toHaveBeenCalledWith("t1", "u1", "cancelled");
  });
});
