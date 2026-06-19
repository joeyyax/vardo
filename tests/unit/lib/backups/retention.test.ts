// Retention must be applied PER VOLUME. A multi-volume job produces one archive
// per volume per run (same timestamp); sharing one retention timeline meant
// keepLast=1 kept a single archive across ALL volumes and pruned the rest —
// e.g. agents kept a 418-byte redis archive and deleted its 14.8 MB postgres
// backup every run. selectKeepersByVolume groups by volumeName first.

import { describe, it, expect } from "vitest";
import { selectKeepersByVolume } from "@/lib/backups/engine";

const T = (n: number) => new Date(2026, 0, 1, 0, 0, n); // distinct, ordered timestamps

describe("selectKeepersByVolume — per-volume retention", () => {
  it("keepLast=1 keeps the newest archive of EACH volume (the agents bug)", () => {
    // One run, two volumes — both must survive.
    const entries = [
      { id: "redis", volumeName: "redis-data", finishedAt: T(6) },
      { id: "pg", volumeName: "postgres-data", finishedAt: T(5) },
    ];
    const keepers = selectKeepersByVolume(entries, {
      keepAll: false, keepLast: 1, keepHourly: null, keepDaily: null,
      keepWeekly: null, keepMonthly: null, keepYearly: null,
    });
    expect(keepers).toEqual(new Set(["redis", "pg"]));
  });

  it("keepLast=1 across two runs keeps each volume's latest, prunes each volume's older", () => {
    // newest-first, interleaved volumes
    const entries = [
      { id: "d2", volumeName: "data", finishedAt: T(4) },
      { id: "p2", volumeName: "postgres", finishedAt: T(3) },
      { id: "d1", volumeName: "data", finishedAt: T(2) },
      { id: "p1", volumeName: "postgres", finishedAt: T(1) },
    ];
    const keepers = selectKeepersByVolume(entries, {
      keepAll: false, keepLast: 1, keepHourly: null, keepDaily: null,
      keepWeekly: null, keepMonthly: null, keepYearly: null,
    });
    // The newest of each volume survives; the older of each is pruned.
    expect(keepers).toEqual(new Set(["d2", "p2"]));
  });

  it("keepAll keeps everything regardless of volume", () => {
    const entries = [
      { id: "a", volumeName: "data", finishedAt: T(2) },
      { id: "b", volumeName: "postgres", finishedAt: T(1) },
    ];
    const keepers = selectKeepersByVolume(entries, {
      keepAll: true, keepLast: null, keepHourly: null, keepDaily: null,
      keepWeekly: null, keepMonthly: null, keepYearly: null,
    });
    expect(keepers).toEqual(new Set(["a", "b"]));
  });
});
