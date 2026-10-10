import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const { reconcileVardoOrgMembers } = await import("@/lib/infra/vardo-org");
const { memberships, invitations } = await import("@/lib/db/schema");

const admins = [
  { id: "admin-1", email: "a1@x.test" },
  { id: "admin-2", email: "a2@x.test" },
];

beforeEach(() => {
  dbMock.reset();
  dbMock.query.user.findMany.mockResolvedValue(admins);
  dbMock.updateReturns([]);
});

describe("reconcileVardoOrgMembers", () => {
  it("removes every non-admin member", async () => {
    dbMock.query.memberships.findMany.mockResolvedValue([
      { id: "m1", userId: "admin-1", role: "owner" },
      { id: "m2", userId: "admin-2", role: "admin" },
      { id: "m3", userId: "intruder", role: "member" },
      { id: "m4", userId: "other", role: "owner" },
    ]);

    await reconcileVardoOrgMembers("vardo");

    expect(dbMock.deletes).toHaveLength(2);
    expect(dbMock.deletes.every((d) => d.table === memberships)).toBe(true);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("adds missing admins, first as owner when no owner is left", async () => {
    dbMock.query.memberships.findMany.mockResolvedValue([{ id: "m4", userId: "other", role: "owner" }]);

    await reconcileVardoOrgMembers("vardo");

    expect(dbMock.inserts.map((i) => i.values)).toEqual([
      expect.objectContaining({ userId: "admin-1", organizationId: "vardo", role: "owner" }),
      expect.objectContaining({ userId: "admin-2", organizationId: "vardo", role: "admin" }),
    ]);
  });

  it("revokes pending invitations to the org", async () => {
    dbMock.query.memberships.findMany.mockResolvedValue([]);

    await reconcileVardoOrgMembers("vardo");

    expect(dbMock.updates).toEqual([expect.objectContaining({ table: invitations, set: { status: "revoked" } })]);
  });

  it("changes no membership when the members already match", async () => {
    dbMock.query.memberships.findMany.mockResolvedValue([
      { id: "m1", userId: "admin-1", role: "owner" },
      { id: "m2", userId: "admin-2", role: "admin" },
    ]);

    await reconcileVardoOrgMembers("vardo");

    expect(dbMock.deletes).toHaveLength(0);
    expect(dbMock.inserts).toHaveLength(0);
  });

  it("removes nobody while no instance admin exists", async () => {
    dbMock.query.user.findMany.mockResolvedValue([]);
    dbMock.query.memberships.findMany.mockResolvedValue([{ id: "m4", userId: "other", role: "owner" }]);

    await reconcileVardoOrgMembers("vardo");

    expect(dbMock.deletes).toHaveLength(0);
    expect(dbMock.updates).toHaveLength(0);
  });
});
