import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findMany: (...args: unknown[]) => findMany(...args) } } },
}));

const { restartCountsByApp, restartReading } = await import("@/lib/db/app-restarts");

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

describe("restartReading", () => {
  const since = new Date("2026-03-01T00:00:00Z");

  it("shapes the stored pair into the reading every surface renders", () => {
    expect(restartReading({ containerRestartCount: 12, containerRestartSince: since })).toEqual({
      count: 12,
      since: since.toISOString(),
    });
  });

  it("keeps a zero reading, which is not the absence of one", () => {
    expect(restartReading({ containerRestartCount: 0, containerRestartSince: since })?.count).toBe(0);
  });

  it("reads null as unread rather than as zero restarts", () => {
    expect(restartReading({ containerRestartCount: null, containerRestartSince: since })).toBeNull();
  });

  it("carries a count with no anchor rather than withholding it", () => {
    expect(restartReading({ containerRestartCount: 4, containerRestartSince: null })).toEqual({
      count: 4,
      since: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("restart column migrations", () => {
  const dir = join(process.cwd(), "drizzle");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  const statementFor = (column: string) =>
    sql.split("\n").find((line) => line.includes(column));

  it("adds the count to the app table", () => {
    const statement = statementFor("container_restart_count");
    expect(statement).toBeDefined();
    expect(statement).toMatch(/ALTER TABLE "app" ADD COLUMN "container_restart_count" integer/);
  });

  it("adds the anchor the count resets from", () => {
    const statement = statementFor("container_restart_since");
    expect(statement).toBeDefined();
    expect(statement).toMatch(/ALTER TABLE "app" ADD COLUMN "container_restart_since" timestamp/);
  });

  it("leaves both nullable with no default, so an unread app is not backfilled with zero", () => {
    for (const column of ["container_restart_count", "container_restart_since"]) {
      expect(statementFor(column)).not.toMatch(/NOT NULL/i);
      expect(statementFor(column)).not.toMatch(/DEFAULT/i);
    }
  });
});
