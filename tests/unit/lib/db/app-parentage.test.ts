import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "drizzle");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const sql = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

const parentageMigration = files
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .find((body) => body.includes("app_parent_app_id_app_id_fk"));

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("app_parent_app_id_app_id_fk migration", () => {
  const constraint = sql
    .split("\n")
    .find((line) => line.includes("ADD CONSTRAINT \"app_parent_app_id_app_id_fk\""));

  it("adds a foreign key from parent_app_id to app(id)", () => {
    expect(constraint).toBeDefined();
    expect(constraint).toMatch(/FOREIGN KEY \("parent_app_id"\)/);
    expect(constraint).toMatch(/REFERENCES "public"\."app"\("id"\)/);
  });

  it("cascades, so children die with the parent", () => {
    expect(constraint).toMatch(/ON DELETE cascade/i);
  });

  it("never sets null, which would promote children to top-level", () => {
    expect(constraint).not.toMatch(/ON DELETE set null/i);
  });
});

describe("orphan cleanup", () => {
  it("ships in the same migration as the constraint", () => {
    expect(parentageMigration).toBeDefined();
    expect(parentageMigration).toMatch(/DELETE FROM "app"/);
  });

  it("runs before the constraint, which would fail on existing orphans", () => {
    const body = parentageMigration!;
    expect(body.indexOf("DELETE FROM \"app\"")).toBeLessThan(
      body.indexOf("ADD CONSTRAINT \"app_parent_app_id_app_id_fk\"")
    );
  });

  it("removes only rows whose parent is missing", () => {
    expect(parentageMigration).toMatch(/"parent_app_id" IS NOT NULL/);
    expect(parentageMigration).toMatch(/NOT EXISTS \(SELECT 1 FROM "app"/);
  });

  it("deletes rather than nulling, keeping them out of the top-level index", () => {
    expect(parentageMigration).not.toMatch(/SET\s+"?parent_app_id"?\s*=\s*NULL/i);
  });

  it("records each removal in the activity feed", () => {
    expect(parentageMigration).toMatch(/INSERT INTO "activity"/);
    expect(parentageMigration).toMatch(/'app\.deleted'/);
  });

  it("leaves the top-level unique index alone", () => {
    const statements = sql
      .split("\n")
      .filter((line) => line.includes("app_top_level_name_uniq"));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/WHERE parent_app_id is null/i);
  });
});

// ---------------------------------------------------------------------------
// Constraint semantics against representative data
// ---------------------------------------------------------------------------

type Row = { id: string; name: string; parentAppId: string | null };

/** Rows the partial unique index on app(name) covers. */
function topLevelScope(rows: Row[]): string[] {
  return rows.filter((r) => r.parentAppId === null).map((r) => r.name).sort();
}

/** Models the migration's orphan DELETE. */
function cleanOrphans(rows: Row[]): Row[] {
  const ids = new Set(rows.map((r) => r.id));
  return rows.filter((r) => r.parentAppId === null || ids.has(r.parentAppId));
}

/** Models ON DELETE CASCADE on parent_app_id. */
function deleteRow(rows: Row[], id: string): Row[] {
  const kept = rows.filter((r) => r.id !== id);
  const children = kept.filter((r) => r.parentAppId === id);
  return children.reduce((acc, child) => deleteRow(acc, child.id), kept);
}

/** True when any row points at a parent that is not present. */
function hasOrphan(rows: Row[]): boolean {
  const ids = new Set(rows.map((r) => r.id));
  return rows.some((r) => r.parentAppId !== null && !ids.has(r.parentAppId));
}

const services = ["postgres", "redis", "web", "worker"];

const production: Row[] = [
  { id: "app-live", name: "glitchtip", parentAppId: null },
  ...services.map((s) => ({
    id: `live-${s}`,
    name: `glitchtip-${s}`,
    parentAppId: "app-live",
  })),
  // The four rows from the Homelab org — parent 5hpcZOD9QbKRRQzOIIFuB is gone.
  ...services.map((s) => ({
    id: `orphan-${s}`,
    name: `glitchtip-${s}`,
    parentAppId: "5hpcZOD9QbKRRQzOIIFuB",
  })),
  { id: "app-invoices", name: "invoices", parentAppId: null },
];

describe("parentage integrity", () => {
  it("deleting a parent removes its children", () => {
    const after = deleteRow(production, "app-live");
    expect(after.map((r) => r.id)).not.toContain("live-web");
    expect(after.filter((r) => r.parentAppId === "app-live")).toHaveLength(0);
  });

  it("leaves an unrelated top-level app in place", () => {
    const after = deleteRow(production, "app-live");
    expect(after.map((r) => r.id)).toContain("app-invoices");
  });

  it("cannot leave an orphan behind once the migration has run", () => {
    expect(hasOrphan(production)).toBe(true);
    expect(hasOrphan(deleteRow(cleanOrphans(production), "app-live"))).toBe(false);
  });

  it("cleans up the four existing orphans", () => {
    const cleaned = cleanOrphans(production);
    expect(cleaned.filter((r) => r.id.startsWith("orphan-"))).toHaveLength(0);
    expect(hasOrphan(cleaned)).toBe(false);
  });
});

describe("top-level name index", () => {
  it("is unchanged by the orphan cleanup", () => {
    expect(topLevelScope(cleanOrphans(production))).toEqual(topLevelScope(production));
  });

  it("would have gained four colliding names had the cleanup nulled instead", () => {
    const promoted = production.map((r) =>
      r.parentAppId === "5hpcZOD9QbKRRQzOIIFuB" ? { ...r, parentAppId: null } : r
    );
    const scope = topLevelScope(promoted);
    expect(scope).toHaveLength(topLevelScope(production).length + 4);
    expect(scope).toContain("glitchtip-web");
  });

  it("keeps children of a cascaded parent out of scope throughout", () => {
    const after = deleteRow(cleanOrphans(production), "app-live");
    expect(topLevelScope(after)).toEqual(["invoices"]);
  });
});
