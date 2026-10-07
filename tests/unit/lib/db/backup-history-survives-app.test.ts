// Deleting an app cascaded into backup, so its history vanished while the
// archives stayed in storage with nothing pointing at them (#867).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { backups, backupJobApps } from "@/lib/db/schema";

function foreignKeysOn(table: Parameters<typeof getTableConfig>[0], column: string) {
  return getTableConfig(table).foreignKeys.filter((fk) =>
    fk.reference().columns.some((c) => c.name === column),
  );
}

describe("backup.app_id", () => {
  it("has no foreign key, so deleting the app leaves the row", () => {
    expect(foreignKeysOn(backups, "app_id")).toHaveLength(0);
  });

  it("snapshots the app's name and organization", () => {
    const columns = getTableConfig(backups).columns.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["app_name", "organization_id"]));
  });
});

describe("backup_job_app.app_id", () => {
  it("still cascades, so a job stops backing up a deleted app", () => {
    const [fk] = foreignKeysOn(backupJobApps, "app_id");
    expect(fk?.onDelete).toBe("cascade");
  });
});

describe("migration", () => {
  const dir = join(process.cwd(), "drizzle");
  const body = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .find((sql) => sql.includes('DROP CONSTRAINT IF EXISTS "backup_app_id_app_id_fk"'));

  it("drops the cascading constraint", () => {
    expect(body).toBeDefined();
  });

  it("backfills the snapshot from the app", () => {
    expect(body).toMatch(/UPDATE "backup" SET "app_name" = "app"\."name", "organization_id" = "app"\."organization_id"/);
  });
});
