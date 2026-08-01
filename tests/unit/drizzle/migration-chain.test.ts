import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A migration that redefines an object an earlier one already created breaks
// `drizzle-kit migrate` on a fresh database. Existing installs never replay, so
// the break only shows up on a new one.
const DIR = join(process.cwd(), "drizzle");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

type Definition = { kind: string; name: string; file: string; guarded: boolean };

const PATTERNS: [RegExp, string][] = [
  [/CREATE INDEX (IF NOT EXISTS )?"([^"]+)"/g, "index"],
  [/CREATE TABLE (IF NOT EXISTS )?"([^"]+)"/g, "table"],
  [/ADD COLUMN (IF NOT EXISTS )?"([^"]+)"/g, "column"],
  [/ADD VALUE (IF NOT EXISTS )?'([^']+)'/g, "enum value"],
];

function definitions(): Definition[] {
  const found: Definition[] = [];
  for (const file of files) {
    const sql = readFileSync(join(DIR, file), "utf8");
    for (const [pattern, kind] of PATTERNS) {
      for (const match of sql.matchAll(pattern)) {
        found.push({ kind, name: match[2], file, guarded: Boolean(match[1]) });
      }
    }
    // A constraint has no IF NOT EXISTS; the guard is dropping it first.
    for (const match of sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)) {
      const dropped = sql.includes(`DROP CONSTRAINT IF EXISTS "${match[1]}"`);
      found.push({ kind: "constraint", name: match[1], file, guarded: dropped });
    }
  }
  return found;
}

describe("migration chain", () => {
  it("reads the migration files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("guards every object defined more than once", () => {
    const seen = new Map<string, Definition>();
    const unguarded: string[] = [];

    for (const def of definitions()) {
      const key = `${def.kind}:${def.name}`;
      const first = seen.get(key);
      // Same file, same name: different tables sharing a column name.
      if (first && first.file !== def.file && !def.guarded) {
        unguarded.push(`${def.kind} "${def.name}" redefined in ${def.file} (first in ${first.file})`);
      }
      if (!first) seen.set(key, def);
    }

    expect(unguarded).toEqual([]);
  });
});
