import { describe, it, expect, beforeEach } from "vitest";
import { dbMock } from "@/tests/helpers/db";
import { jsonRequest, routeCtx } from "@/tests/helpers/request";

beforeEach(() => dbMock.reset());

describe("dbMock", () => {
  it("scripts query results per table", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1" });
    expect(await dbMock.db.query.apps.findFirst()).toEqual({ id: "a1" });
    expect(await dbMock.db.query.apps.findMany()).toEqual([]);
    expect(await dbMock.db.query.other.findFirst()).toBeUndefined();
  });

  it("records insert values and returns scripted rows", async () => {
    dbMock.insertReturns([{ id: "n1" }]);
    const rows = await dbMock.db.insert("t").values({ name: "x" }).returning();
    expect(rows).toEqual([{ id: "n1" }]);
    expect(dbMock.inserts).toEqual([{ table: "t", values: { name: "x" } }]);
  });

  it("records update set/where and resolves without returning", async () => {
    await dbMock.db.update("t").set({ a: 1 }).where("cond");
    expect(dbMock.updates).toEqual([{ table: "t", set: { a: 1 }, where: "cond" }]);
  });

  it("records deletes", async () => {
    dbMock.deleteReturns([{ id: "d" }]);
    expect(await dbMock.db.delete("t").where("c").returning()).toEqual([{ id: "d" }]);
    expect(dbMock.deletes).toHaveLength(1);
  });

  it("reset clears recorded writes and scripted results", async () => {
    dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1" });
    dbMock.insertReturns([{ id: "n" }]);
    await dbMock.db.insert("t").values({});
    dbMock.reset();
    expect(dbMock.inserts).toEqual([]);
    expect(await dbMock.db.query.apps.findFirst()).toBeUndefined();
    expect(await dbMock.db.insert("t").values({}).returning()).toEqual([]);
  });
});

describe("request helpers", () => {
  it("sends a JSON body with a content type", async () => {
    const req = jsonRequest("POST", "/api/x", { body: { a: 1 }, query: { q: "2" } });
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.nextUrl.searchParams.get("q")).toBe("2");
    expect(await req.json()).toEqual({ a: 1 });
  });

  it("sends no body on GET", () => {
    expect(jsonRequest("GET", "/api/x", { body: { a: 1 } }).body).toBeNull();
  });

  it("wraps route params in a promise", async () => {
    expect(await routeCtx({ orgId: "o" }).params).toEqual({ orgId: "o" });
  });
});
