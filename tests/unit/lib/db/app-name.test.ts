import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { query: { apps: { findFirst: (...args: unknown[]) => findFirst(...args) } } },
}));

const {
  APP_NAME_TAKEN_ERROR,
  ORG_NAME_CONSTRAINT,
  TOP_LEVEL_NAME_CONSTRAINT,
  isAppNameViolation,
  isTopLevelAppNameTaken,
} = await import("@/lib/db/app-name");

beforeEach(() => {
  findFirst.mockReset();
});

// The unique index itself is asserted against Postgres in tests/unit/drizzle/migrate-run.test.ts.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("APP_NAME_TAKEN_ERROR", () => {
  it("says instance-wide and not per-organization", () => {
    expect(APP_NAME_TAKEN_ERROR).toMatch(/instance/i);
    expect(APP_NAME_TAKEN_ERROR).not.toMatch(/in this organization/i);
  });

  it("names no organization", () => {
    expect(APP_NAME_TAKEN_ERROR).not.toMatch(/\borg-/i);
  });
});

/** Column names a Drizzle where-clause reads, walked out of its query chunks. */
function referencedColumns(where: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && "table" in record) {
      found.push(record.name);
      return;
    }
    if (Array.isArray(record.queryChunks)) walk(record.queryChunks);
  };
  walk(where);
  return found;
}

describe("isTopLevelAppNameTaken", () => {
  it("is true when a top-level app holds the name", async () => {
    findFirst.mockResolvedValue({ id: "app-1" });
    await expect(isTopLevelAppNameTaken("invoices")).resolves.toBe(true);
  });

  it("is false when nothing holds the name", async () => {
    findFirst.mockResolvedValue(undefined);
    await expect(isTopLevelAppNameTaken("invoices")).resolves.toBe(false);
  });

  it("filters on name and parent_app_id, never organization_id", async () => {
    findFirst.mockResolvedValue(undefined);
    await isTopLevelAppNameTaken("invoices");
    const columns = referencedColumns(findFirst.mock.calls[0]?.[0]?.where);
    expect(columns).toContain("name");
    expect(columns).toContain("parent_app_id");
    expect(columns).not.toContain("organization_id");
  });
});

describe("isAppNameViolation", () => {
  const violation = (constraint?: string) =>
    Object.assign(new Error("duplicate key"), { code: "23505", constraint });

  it("matches the top-level constraint", () => {
    expect(isAppNameViolation(violation(TOP_LEVEL_NAME_CONSTRAINT))).toBe(true);
  });

  it("matches the legacy per-org constraint", () => {
    expect(isAppNameViolation(violation(ORG_NAME_CONSTRAINT))).toBe(true);
  });

  it("reads the constraint off error.cause", () => {
    const err = new Error("wrapped", {
      cause: { code: "23505", constraint: TOP_LEVEL_NAME_CONSTRAINT },
    });
    expect(isAppNameViolation(err)).toBe(true);
  });

  it("ignores unique violations on other constraints", () => {
    expect(isAppNameViolation(violation("app_imported_container_uniq"))).toBe(false);
  });

  it("ignores non-unique-violation errors", () => {
    expect(isAppNameViolation(new Error("boom"))).toBe(false);
  });
});
