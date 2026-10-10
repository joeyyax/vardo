import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const { mayBeMember } = await import("@/lib/auth/system-org");

beforeEach(() => dbMock.reset());

describe("mayBeMember", () => {
  it("allows anyone into an ordinary org without reading the user", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue({ isSystemManaged: false });
    expect(await mayBeMember("org-1", "u1")).toBe(true);
    expect(dbMock.query.user.findFirst).not.toHaveBeenCalled();
  });

  it("allows an instance admin into the system org", async () => {
    dbMock.query.organizations.findFirst.mockResolvedValue({ isSystemManaged: true });
    dbMock.query.user.findFirst.mockResolvedValue({ isAppAdmin: true });
    expect(await mayBeMember("vardo", "u1")).toBe(true);
  });

  it.each([{ isAppAdmin: false }, { isAppAdmin: null }, undefined])(
    "refuses anyone else into the system org (%o)",
    async (row) => {
      dbMock.query.organizations.findFirst.mockResolvedValue({ isSystemManaged: true });
      dbMock.query.user.findFirst.mockResolvedValue(row);
      expect(await mayBeMember("vardo", "u1")).toBe(false);
    },
  );
});
