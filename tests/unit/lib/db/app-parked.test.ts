import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateMock, setMock, whereMock } = vi.hoisted(() => {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: whereMock }));
  return { updateMock: vi.fn(() => ({ set: setMock })), setMock, whereMock };
});

vi.mock("@/lib/db", () => ({ db: { update: updateMock } }));

import { PgDialect } from "drizzle-orm/pg-core";
import { setParked } from "@/lib/db/app-parked";

const dialect = new PgDialect();
const NOW = new Date("2026-08-03T03:58:57.000Z");

beforeEach(() => vi.clearAllMocks());

describe("setParked", () => {
  it("writes the flag and the same clock to updatedAt", async () => {
    await setParked("app-1", true, NOW);

    expect(setMock).toHaveBeenCalledWith({ parked: true, updatedAt: NOW });
  });

  it("carries the declaration to every service under the app", async () => {
    await setParked("agents", true, NOW);

    const { sql, params } = dialect.sqlToQuery(whereMock.mock.calls[0][0]);
    expect(sql).toContain('"app"."parent_app_id" =');
    expect(params).toEqual(["agents", "agents"]);
  });

  it("unparks through the same cascade", async () => {
    await setParked("agents", false, NOW);

    expect(setMock).toHaveBeenCalledWith({ parked: false, updatedAt: NOW });
    expect(dialect.sqlToQuery(whereMock.mock.calls[0][0]).sql).toContain('"app"."parent_app_id" =');
  });
});
