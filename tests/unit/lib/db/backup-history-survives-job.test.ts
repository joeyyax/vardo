// Deleting a backup job cascaded into backup, erasing its history while the
// archives stayed in storage (#871).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { backups } from "@/lib/db/schema";

describe("backup.job_id", () => {
  const fks = getTableConfig(backups).foreignKeys.filter((fk) =>
    fk.reference().columns.some((c) => c.name === "job_id"),
  );

  it("is set to null when the job is deleted, so the row stays", () => {
    expect(fks).toHaveLength(1);
    expect(fks[0].onDelete).toBe("set null");
  });

  it("is nullable", () => {
    const column = getTableConfig(backups).columns.find((c) => c.name === "job_id");
    expect(column?.notNull).toBe(false);
  });

  it("is paired with a job name snapshot", () => {
    const columns = getTableConfig(backups).columns.map((c) => c.name);
    expect(columns).toContain("job_name");
  });
});

describe("migration", () => {
  const dir = join(process.cwd(), "drizzle");
  const body = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .find((sql) => sql.includes('ADD COLUMN IF NOT EXISTS "job_name"'));

  it("backfills the snapshot from the job", () => {
    expect(body).toMatch(/UPDATE "backup" SET "job_name" = "backup_job"\."name" FROM "backup_job"/);
  });
});
