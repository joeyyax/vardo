import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("app_top_level_name_uniq migration", () => {
  const dir = join(process.cwd(), "drizzle");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  const statement = sql
    .split("\n")
    .find((line) => line.includes("app_top_level_name_uniq"));

  it("creates a unique index on name alone", () => {
    expect(statement).toBeDefined();
    expect(statement).toMatch(/CREATE UNIQUE INDEX/);
    expect(statement).toMatch(/ON "app" USING btree \("name"\)/);
  });

  it("is partial on top-level apps, so children are exempt", () => {
    expect(statement).toMatch(/WHERE parent_app_id is null/i);
  });

  it("is not scoped to the organization", () => {
    expect(statement).not.toMatch(/organization_id/);
  });
});

// ---------------------------------------------------------------------------
// Constraint semantics against representative data
// ---------------------------------------------------------------------------

type Row = { name: string; orgId: string; parentAppId: string | null };

/** Models `UNIQUE (name) WHERE parent_app_id IS NULL`. */
function violatesTopLevelUniq(rows: Row[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.parentAppId !== null) continue;
    if (seen.has(row.name)) return true;
    seen.add(row.name);
  }
  return false;
}

describe("top-level name uniqueness", () => {
  it("rejects the same top-level name in two organizations", () => {
    expect(
      violatesTopLevelUniq([
        { name: "invoices", orgId: "org-a", parentAppId: null },
        { name: "invoices", orgId: "org-b", parentAppId: null },
      ])
    ).toBe(true);
  });

  it("allows two children of different parents to share a name", () => {
    expect(
      violatesTopLevelUniq([
        { name: "glitchtip", orgId: "org-a", parentAppId: null },
        { name: "glitchtip-web", orgId: "org-a", parentAppId: "app-a" },
        { name: "glitchtip-web", orgId: "org-b", parentAppId: "app-b" },
      ])
    ).toBe(false);
  });

  it("applies against the existing glitchtip child collisions", () => {
    // Four child names duplicated across two parents. Children are exempt from
    // the index whatever their parent, so the names never collide.
    const services = ["postgres", "redis", "web", "worker"];
    const rows: Row[] = [
      { name: "glitchtip", orgId: "org-a", parentAppId: null },
      ...services.map((s) => ({
        name: `glitchtip-${s}`,
        orgId: "org-a",
        parentAppId: "app-live",
      })),
      ...services.map((s) => ({
        name: `glitchtip-${s}`,
        orgId: "org-b",
        parentAppId: "app-other",
      })),
    ];
    expect(violatesTopLevelUniq(rows)).toBe(false);
  });
});

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
