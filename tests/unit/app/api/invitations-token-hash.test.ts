// Invitations are looked up by the hash of the token in the link, and a new
// link is issued rather than read back.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { invitationsFindFirst, userFindFirst, updateSet, sendEmail } = vi.hoisted(() => ({
  invitationsFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  updateSet: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      invitations: { findFirst: invitationsFindFirst },
      user: { findFirst: userFindFirst },
    },
    update: () => ({
      set: (data: Record<string, unknown>) => {
        updateSet(data);
        return { where: () => ({ returning: async () => [{ id: "inv-1" }] }) };
      },
    }),
  },
}));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: { name: string }, val: unknown) => ({ col: col.name, val }),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn(async () => null) }));
vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));
vi.mock("@/lib/api/verify-access", () => ({
  verifyOrgAccess: vi.fn(async () => ({ organization: { name: "Acme" }, session: { user: { id: "u-1" } } })),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail,
  emailDelivery: (sent: unknown) => ({ configured: true, sent: !!sent }),
}));
vi.mock("@/lib/email/templates/invite", () => ({ InviteEmail: (props: unknown) => props }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { hashInvitationToken } = await import("@/lib/invitations/token");
const { POST: accept } = await import("@/app/api/v1/invitations/accept/route");
const { PATCH: reissue } = await import("@/app/api/v1/organizations/[orgId]/invitations/[invitationId]/route");

const params = { params: Promise.resolve({ orgId: "org-1", invitationId: "inv-1" }) };

function patch(body?: unknown) {
  return new NextRequest("http://localhost/api", {
    method: "PATCH",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invitationsFindFirst.mockResolvedValue({ id: "inv-1", email: "a@example.com", status: "pending" });
});

describe("accept", () => {
  it("looks the invitation up by the hash of the presented token", async () => {
    invitationsFindFirst.mockResolvedValue(undefined);
    const req = new NextRequest("http://localhost/api/v1/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token: "raw-token" }),
      headers: { "Content-Type": "application/json" },
    });

    await accept(req, { params: Promise.resolve({}) });

    expect(invitationsFindFirst).toHaveBeenCalledWith({
      where: { col: "token_hash", val: hashInvitationToken("raw-token") },
    });
  });
});

describe("reissue", () => {
  it("stores the hash of a new token and emails the raw one", async () => {
    const res = await reissue(patch(), params);
    const data = await res.json();

    const raw = data.inviteUrl.split("/invite/")[1];
    expect(updateSet).toHaveBeenCalledWith({ tokenHash: hashInvitationToken(raw) });
    expect(sendEmail.mock.calls[0][0].template.inviteUrl).toBe(data.inviteUrl);
  });

  it("returns a new link without emailing when send is false", async () => {
    const res = await reissue(patch({ send: false }), params);
    const data = await res.json();

    expect(data.inviteUrl).toMatch(/\/invite\/[0-9a-f]{64}$/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
