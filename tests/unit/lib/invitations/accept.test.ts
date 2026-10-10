import { describe, it, expect, vi, beforeEach } from "vitest";

const { returning, insertValues, membershipFind, whereArgs, mayBeMember } = vi.hoisted(() => ({
  mayBeMember: vi.fn(),
  returning: vi.fn(),
  insertValues: vi.fn(),
  membershipFind: vi.fn(),
  whereArgs: [] as unknown[],
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (col: { name: string }, val: unknown) => ({ op: "eq", col: col.name, val }),
  gt: (col: { name: string }) => ({ op: "gt", col: col.name }),
  and: (...parts: unknown[]) => parts,
}));

vi.mock("@/lib/db", () => {
  const tx = {
    update: () => ({
      set: () => ({
        where: (w: unknown) => {
          whereArgs.push(w);
          return { returning };
        },
      }),
    }),
    query: { memberships: { findFirst: membershipFind } },
    insert: () => ({ values: insertValues }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

vi.mock("@/lib/auth/system-org", () => ({ mayBeMember }));

const { claimInvitation } = await import("@/lib/invitations/accept");

const invitation = {
  id: "inv-1",
  scope: "org",
  targetId: "org-1",
  role: "member",
  status: "revoked",
} as unknown as Parameters<typeof claimInvitation>[0];

beforeEach(() => {
  vi.clearAllMocks();
  whereArgs.length = 0;
  membershipFind.mockResolvedValue(undefined);
  mayBeMember.mockResolvedValue(true);
});

describe("claimInvitation", () => {
  it("only claims a pending, unexpired row", async () => {
    returning.mockResolvedValue([{ id: "inv-1" }]);
    await claimInvitation(invitation, "u-1");
    expect(whereArgs[0]).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "status", val: "pending" },
        { op: "gt", col: "expires_at" },
      ]),
    );
  });

  it("adds no membership when the row wasn't claimable, e.g. revoked", async () => {
    returning.mockResolvedValue([]);
    expect(await claimInvitation(invitation, "u-1")).toBe("invalid");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("adds the membership once claimed", async () => {
    returning.mockResolvedValue([{ id: "inv-1" }]);
    expect(await claimInvitation(invitation, "u-1")).toBe("claimed");
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", userId: "u-1" }));
  });

  it("refuses a user the target org won't take, before claiming", async () => {
    mayBeMember.mockResolvedValue(false);
    returning.mockResolvedValue([{ id: "inv-1" }]);
    expect(await claimInvitation(invitation, "u-1")).toBe("not-allowed");
    expect(mayBeMember).toHaveBeenCalledWith("org-1", "u-1");
    expect(returning).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
