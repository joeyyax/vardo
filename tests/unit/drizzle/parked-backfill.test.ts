// ---------------------------------------------------------------------------
// The 0057 backfill, asserted as text.
//
// Both halves are one-shot SQL no runtime ever executes again, and both are
// wrong in ways that look right: a duration measured from the wrong column
// reads as a real number, and an unparked stack goes loud without erroring.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = readFileSync(join(process.cwd(), "drizzle/0057_milky_spacker_dave.sql"), "utf8");

/** Statements with their leading comments dropped — only what Postgres runs. */
const statements = FILE.split("--> statement-breakpoint").map((s) =>
  s.replace(/^\s*--(?!>).*$/gm, "").trim(),
);

const SQL = statements.join("\n");
const stampWrites = statements.filter((s) => /SET\s+"status_changed_at"/.test(s));

describe("status_changed_at backfill", () => {
  it("dates only what was measured, and only from the container's own start", () => {
    expect(stampWrites).toHaveLength(1);
    expect(stampWrites[0]).toMatch(/SET\s+"status_changed_at"\s*=\s*"container_started_at"/);
    expect(stampWrites[0]).toMatch(/"status"\s*=\s*'active'/);
    expect(stampWrites[0]).toMatch(/"container_started_at"\s+IS\s+NOT\s+NULL/);
  });

  it("never stands last_running_at or updated_at in for a stamp nobody took", () => {
    // 0051 set last_running_at to now() on every row that existed, so it dates
    // the migration rather than the outage. updated_at moves on a compose edit.
    expect(stampWrites[0]).not.toMatch(/"last_running_at"/);
    expect(stampWrites[0]).not.toMatch(/"updated_at"/);
    expect(stampWrites[0]).not.toMatch(/now\(\)/i);
  });

  it("leaves every status but active null, so no duration is claimed for them", () => {
    for (const status of ["stopped", "missing", "error", "deploying"]) {
      expect(stampWrites[0]).not.toContain(`'${status}'`);
    }
    expect(stampWrites[0]).toMatch(/"status_changed_at"\s+IS\s+NULL/);
  });
});

describe("parked backfill", () => {
  const parkWrites = statements.filter((s) => /SET\s+"parked"\s*=\s*true/.test(s));

  it("adds the column unparked, so nothing that arrives later is silent by default", () => {
    expect(SQL).toMatch(/ADD COLUMN "parked" boolean DEFAULT false NOT NULL/);
  });

  it("parks the stacks that were already shelved, and only those", () => {
    const named = [...SQL.matchAll(/'(agents|encoder|jellyfin|lonvr)'/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(["agents", "encoder", "jellyfin", "lonvr"]));
    expect(parkWrites[0]).toMatch(/"parent_app_id"\s+IS\s+NULL/);
  });

  it("carries the declaration down to every service in those stacks", () => {
    expect(parkWrites).toHaveLength(2);
    expect(parkWrites[1]).toMatch(/"parent_app_id"\s+IN\s*\(SELECT "id" FROM "app" WHERE "parked" = true\)/);
  });
});
