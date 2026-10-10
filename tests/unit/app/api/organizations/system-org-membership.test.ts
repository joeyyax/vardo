// The system org's members are exactly the instance admins: it takes no
// invitations, and every path that adds or selects a membership checks the rule.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const { mockVerifyOrgAccess, mockGetSession, mayBeMember, claimInvitation, cookieSet } = vi.hoisted(() => ({
  mockVerifyOrgAccess: vi.fn(),
  mockGetSession: vi.fn(),
  mayBeMember: vi.fn(),
  claimInvitation: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/auth/session", () => ({
  getSession: mockGetSession,
  isScopedToken: () => false,
  CURRENT_ORG_COOKIE: "host_current_org",
}));
vi.mock("@/lib/auth/system-org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/system-org")>()),
  mayBeMember,
}));
vi.mock("@/lib/invitations/accept", () => ({ claimInvitation }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(), emailDelivery: vi.fn() }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const invitations = await import("@/app/api/v1/organizations/[orgId]/invitations/route");
const invitation = await import("@/app/api/v1/organizations/[orgId]/invitations/[invitationId]/route");
const members = await import("@/app/api/v1/organizations/[orgId]/members/route");
const accept = await import("@/app/api/v1/invitations/accept/route");
const switchOrg = await import("@/app/api/v1/organizations/switch/route");

const ORG = "/api/v1/organizations/vardo-org";

function asOwnerOf(isSystemManaged: boolean) {
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: "vardo-org", name: "Vardo", isSystemManaged },
    membership: { role: "owner" },
    session: { user: { id: "admin-1" }, authMethod: "session" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  mockGetSession.mockResolvedValue({ user: { id: "u1", email: "u1@x.test" }, authMethod: "session" });
});

describe("invitations into the system org", () => {
  it("refuses creating one, even for an owner", async () => {
    asOwnerOf(true);
    const res = await invitations.POST(
      jsonRequest("POST", `${ORG}/invitations`, { body: { email: "a@x.test" } }),
      routeCtx({ orgId: "vardo-org" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/doesn't take invitations/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("refuses reissuing a link", async () => {
    asOwnerOf(true);
    const res = await invitation.PATCH(
      jsonRequest("PATCH", `${ORG}/invitations/i1`, { body: {} }),
      routeCtx({ orgId: "vardo-org", invitationId: "i1" }),
    );
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("still invites into an ordinary org", async () => {
    asOwnerOf(false);
    dbMock.query.user.findFirst.mockResolvedValue({ name: "Owner" });
    const res = await invitations.POST(
      jsonRequest("POST", `${ORG}/invitations`, { body: { email: "a@x.test" } }),
      routeCtx({ orgId: "vardo-org" }),
    );
    expect(res.status).not.toBe(403);
  });
});

describe("POST members", () => {
  const add = () =>
    members.POST(
      jsonRequest("POST", `${ORG}/members`, { body: { email: "a@x.test" } }),
      routeCtx({ orgId: "vardo-org" }),
    );

  beforeEach(() => {
    asOwnerOf(true);
    dbMock.query.user.findFirst.mockResolvedValue({ id: "u2", name: "A", email: "a@x.test" });
    dbMock.query.memberships.findFirst.mockResolvedValue(undefined);
  });

  it("refuses adding a user the org won't take", async () => {
    mayBeMember.mockResolvedValue(false);
    const res = await add();
    expect(res.status).toBe(403);
    expect(mayBeMember).toHaveBeenCalledWith("vardo-org", "u2");
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("adds a user the org takes", async () => {
    mayBeMember.mockResolvedValue(true);
    expect((await add()).status).toBe(201);
    expect(dbMock.insert).toHaveBeenCalled();
  });
});

describe("POST invitations/accept", () => {
  it("answers 403 when the invitee may not join", async () => {
    dbMock.query.invitations.findFirst.mockResolvedValue({
      id: "i1",
      email: "u1@x.test",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      scope: "org",
      targetId: "vardo-org",
    });
    claimInvitation.mockResolvedValue("not-allowed");
    const res = await accept.POST(
      jsonRequest("POST", "/api/v1/invitations/accept", { body: { token: "t" } }),
      routeCtx({}),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only instance admins/);
  });
});

describe("POST organizations/switch", () => {
  const go = () =>
    switchOrg.POST(
      jsonRequest("POST", "/api/v1/organizations/switch", { body: { organizationId: "vardo-org" } }),
      routeCtx({}),
    );

  beforeEach(() => {
    dbMock.query.memberships.findFirst.mockResolvedValue({ id: "m1" });
  });

  it("refuses a stale membership in the system org for a non-admin", async () => {
    mayBeMember.mockResolvedValue(false);
    expect((await go()).status).toBe(403);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("switches when the rule allows it", async () => {
    mayBeMember.mockResolvedValue(true);
    expect((await go()).status).toBe(200);
    expect(cookieSet).toHaveBeenCalled();
  });
});
