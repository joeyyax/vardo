import { describe, it, expect } from "vitest";
import { backupCoverageRows, type CoverageApp } from "@/lib/attention/backup-coverage-rows";

const app = (over: Partial<CoverageApp> = {}): CoverageApp => ({
  id: "a1",
  name: "shop",
  displayName: "Shop",
  status: "uncovered",
  volumeCount: 2,
  ...over,
});

describe("backupCoverageRows", () => {
  it("says so on a fresh install with nothing deployed", () => {
    const rows = backupCoverageRows({ hasTarget: false, uncovered: [], systemJob: null });
    expect(rows.map((r) => r.key)).toEqual(["backup-no-target"]);
    expect(rows[0].items[0].name).toBe("No backup target configured");
  });

  it("lists apps with data no job captures", () => {
    const rows = backupCoverageRows({
      hasTarget: true,
      uncovered: [app(), app({ id: "a2", name: "api", displayName: null, status: "partial" })],
      systemJob: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].footer).toBe("2 apps with data no backup job captures.");
    expect(rows[0].items.map((i) => i.detail)).toEqual(["2 volumes, no backup job", "Some volumes left out"]);
    expect(rows[0].items[1]).toMatchObject({ name: "api", href: "/apps/api/backups" });
  });

  it("flags Vardo's database when its job is missing, off or overdue", () => {
    for (const systemJob of [
      { kind: "missing" as const },
      { kind: "disabled" as const },
      { kind: "overdue" as const, since: new Date("2026-09-01"), neverRan: false },
    ]) {
      const rows = backupCoverageRows({ hasTarget: true, uncovered: [], systemJob });
      expect(rows.map((r) => r.key)).toEqual(["backup-system-db"]);
    }
  });

  it("stays quiet when everything is covered", () => {
    expect(backupCoverageRows({ hasTarget: true, uncovered: [], systemJob: { kind: "ok" } })).toEqual([]);
  });

  it("leaves the database to the no-target row when there is no target", () => {
    const rows = backupCoverageRows({ hasTarget: false, uncovered: [], systemJob: { kind: "missing" } });
    expect(rows.map((r) => r.key)).toEqual(["backup-no-target"]);
  });
});
