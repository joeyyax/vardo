import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: (...args: unknown[]) => findMany(...args) } } },
}));

const { restartCountsByApp } = await import("@/lib/db/app-restarts");

beforeEach(() => {
  findMany.mockReset();
});

describe("restartCountsByApp", () => {
  it("keys the stored count by app id", async () => {
    findMany.mockResolvedValue([
      { id: "a", containerRestartCount: 4 },
      { id: "b", containerRestartCount: 0 },
    ]);
    expect(await restartCountsByApp(["a", "b"])).toEqual(
      new Map([
        ["a", 4],
        ["b", 0],
      ]),
    );
  });

  it("keeps a zero count, which is a reading like any other", async () => {
    findMany.mockResolvedValue([{ id: "a", containerRestartCount: 0 }]);
    expect((await restartCountsByApp(["a"])).get("a")).toBe(0);
  });

  it("leaves out an app with no reading rather than calling it zero", async () => {
    findMany.mockResolvedValue([{ id: "a", containerRestartCount: null }]);
    const counts = await restartCountsByApp(["a"]);
    expect(counts.has("a")).toBe(false);
    expect(counts.get("a")).toBeUndefined();
  });

  it("asks for nothing when there are no apps to ask about", async () => {
    expect(await restartCountsByApp([])).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("container_restart_count migration", () => {
  const dir = join(process.cwd(), "drizzle");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  const statement = sql
    .split("\n")
    .find((line) => line.includes("container_restart_count"));

  it("adds the column to the app table", () => {
    expect(statement).toBeDefined();
    expect(statement).toMatch(/ALTER TABLE "app" ADD COLUMN "container_restart_count" integer/);
  });

  it("is nullable and has no default, so an unread app is not backfilled with zero", () => {
    expect(statement).not.toMatch(/NOT NULL/i);
    expect(statement).not.toMatch(/DEFAULT/i);
  });
});
