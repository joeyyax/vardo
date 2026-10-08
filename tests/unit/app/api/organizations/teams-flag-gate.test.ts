// With teams off, every membership-management mutation answers 404 before
// touching the database. Sign-in and membership resolution never read the flag
// (tests/unit/lib/config/feature-flags.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

const { teamsEnabled, mockVerifyOrgAccess } = vi.hoisted(() => ({
  teamsEnabled: vi.fn(),
  mockVerifyOrgAccess: vi.fn(),
}));

vi.mock("@/lib/config/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/features")>()),
  isFeatureEnabledAsync: async (flag: string) => (flag === "teams" ? teamsEnabled() : true),
}));
vi.mock("@/lib/api/verify-access", () => ({ verifyOrgAccess: mockVerifyOrgAccess }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/rate-limit", async () => (await import("@/tests/helpers/mocks")).rateLimitModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const invitations = await import("@/app/api/v1/organizations/[orgId]/invitations/route");
const invitation = await import("@/app/api/v1/organizations/[orgId]/invitations/[invitationId]/route");
const members = await import("@/app/api/v1/organizations/[orgId]/members/route");
const member = await import("@/app/api/v1/organizations/[orgId]/members/[userId]/route");
const accept = await import("@/app/api/v1/invitations/accept/route");

type Handler = (req: Request, ctx: unknown) => Promise<Response>;

const ORG = "/api/v1/organizations/o1";
const cases: Array<[string, Handler, string, string, Record<string, string>]> = [
  ["POST invitations", invitations.POST as Handler, "POST", `${ORG}/invitations`, { orgId: "o1" }],
  ["PATCH invitations/[id]", invitation.PATCH as Handler, "PATCH", `${ORG}/invitations/i1`, { orgId: "o1", invitationId: "i1" }],
  ["DELETE invitations/[id]", invitation.DELETE as Handler, "DELETE", `${ORG}/invitations/i1`, { orgId: "o1", invitationId: "i1" }],
  ["POST members", members.POST as Handler, "POST", `${ORG}/members`, { orgId: "o1" }],
  ["PATCH members/[id]", member.PATCH as Handler, "PATCH", `${ORG}/members/u2`, { orgId: "o1", userId: "u2" }],
  ["DELETE members/[id]", member.DELETE as Handler, "DELETE", `${ORG}/members/u2`, { orgId: "o1", userId: "u2" }],
  ["POST invitations/accept", accept.POST as Handler, "POST", "/api/v1/invitations/accept", {}],
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  mockVerifyOrgAccess.mockResolvedValue({
    organization: { id: "o1" },
    membership: { role: "owner" },
    session: { user: { id: "u1" }, authMethod: "session" },
  });
});

describe.each(cases)("%s", (_name, handler, method, path, params) => {
  const call = () => handler(jsonRequest(method, path, { body: {} }), routeCtx(params));

  it("answers 404 and writes nothing when teams is off", async () => {
    teamsEnabled.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/isn't enabled/);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("gets past the gate when teams is on", async () => {
    teamsEnabled.mockReturnValue(true);
    const body = await (await call()).json().catch(() => ({}));
    expect(String(body.error ?? "")).not.toMatch(/isn't enabled/);
  });
});
