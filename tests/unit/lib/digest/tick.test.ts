import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// isDueNow — tick scheduling logic
// ---------------------------------------------------------------------------
// Extracted from lib/digest/tick.ts for isolated unit testing.

type DigestSettings = {
  enabled: boolean;
  day: number;  // 0=Sunday … 6=Saturday
  hour: number; // 0-23
};

function isDueNow(settings: DigestSettings, now: Date): boolean {
  return now.getDay() === settings.day && now.getHours() === settings.hour;
}

describe("isDueNow — digest tick scheduling", () => {
  // Monday (day=1) at 09:00 UTC
  const mondayAt9 = new Date(2026, 2, 23, 9, 0, 0); // March 23, 2026 is a Monday

  it("returns true when day and hour match exactly", () => {
    const settings: DigestSettings = { enabled: true, day: 1, hour: 9 };
    expect(isDueNow(settings, mondayAt9)).toBe(true);
  });

  it("returns false when the day does not match", () => {
    const settings: DigestSettings = { enabled: true, day: 2, hour: 9 }; // Tuesday
    expect(isDueNow(settings, mondayAt9)).toBe(false);
  });

  it("returns false when the hour does not match", () => {
    const settings: DigestSettings = { enabled: true, day: 1, hour: 10 };
    expect(isDueNow(settings, mondayAt9)).toBe(false);
  });

  it("returns false when both day and hour differ", () => {
    const settings: DigestSettings = { enabled: true, day: 5, hour: 14 };
    expect(isDueNow(settings, mondayAt9)).toBe(false);
  });

  it("handles Sunday (day=0) correctly", () => {
    const sunday = new Date(2026, 2, 22, 8, 0, 0); // March 22, 2026 is a Sunday
    const settings: DigestSettings = { enabled: true, day: 0, hour: 8 };
    expect(isDueNow(settings, sunday)).toBe(true);
  });

  it("handles Saturday (day=6) correctly", () => {
    const saturday = new Date(2026, 2, 21, 12, 0, 0); // March 21, 2026 is a Saturday
    const settings: DigestSettings = { enabled: true, day: 6, hour: 12 };
    expect(isDueNow(settings, saturday)).toBe(true);
  });

  it("returns false at the start of the correct day but wrong hour", () => {
    const monday0am = new Date(2026, 2, 23, 0, 0, 0);
    const settings: DigestSettings = { enabled: true, day: 1, hour: 9 };
    expect(isDueNow(settings, monday0am)).toBe(false);
  });

  it("returns false at the correct hour on the wrong day", () => {
    const tuesday9am = new Date(2026, 2, 24, 9, 0, 0); // Tuesday
    const settings: DigestSettings = { enabled: true, day: 1, hour: 9 }; // Monday
    expect(isDueNow(settings, tuesday9am)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSameHour — duplicate-send guard (TOCTOU prevention)
// ---------------------------------------------------------------------------
// Mirrors lib/digest/tick.ts:isSameHour — used to prevent two concurrent ticks
// from both sending the digest in the same scheduling window.

function isSameHour(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours()
  );
}

describe("isSameHour — duplicate-send guard", () => {
  it("returns true for two dates in the same hour", () => {
    const a = new Date(2026, 2, 23, 9, 0, 0);
    const b = new Date(2026, 2, 23, 9, 59, 59);
    expect(isSameHour(a, b)).toBe(true);
  });

  it("returns false for dates one hour apart", () => {
    const a = new Date(2026, 2, 23, 9, 0, 0);
    const b = new Date(2026, 2, 23, 10, 0, 0);
    expect(isSameHour(a, b)).toBe(false);
  });

  it("returns false for the same time on different days", () => {
    const a = new Date(2026, 2, 23, 9, 0, 0);
    const b = new Date(2026, 2, 24, 9, 0, 0);
    expect(isSameHour(a, b)).toBe(false);
  });

  it("returns false for the same day/hour in different months", () => {
    const a = new Date(2026, 2, 23, 9, 0, 0); // March
    const b = new Date(2026, 3, 23, 9, 0, 0); // April
    expect(isSameHour(a, b)).toBe(false);
  });

  it("returns false for the same day/hour in different years", () => {
    const a = new Date(2026, 2, 23, 9, 0, 0);
    const b = new Date(2025, 2, 23, 9, 0, 0);
    expect(isSameHour(a, b)).toBe(false);
  });

  it("returns true when both dates are identical", () => {
    const a = new Date(2026, 2, 23, 9, 30, 0);
    const b = new Date(2026, 2, 23, 9, 30, 0);
    expect(isSameHour(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Atomic lastSentAt claim — TOCTOU prevention
// ---------------------------------------------------------------------------
// The tick writes lastSentAt BEFORE sending the digest so that a concurrent
// tick that reads lastSentAt sees it and aborts. These tests model that
// contract without touching the DB.

describe("atomic lastSentAt claim", () => {
  it("a concurrent tick that reads a claimed lastSentAt is blocked", () => {
    // Simulate: tick A claims the hour, tick B checks and finds it claimed
    const sendHour = new Date(2026, 2, 23, 9, 0, 0);

    let claimedAt: Date | null = null;

    function claimSend(now: Date): boolean {
      if (claimedAt && isSameHour(claimedAt, now)) return false; // already claimed
      claimedAt = now;
      return true;
    }

    const tickA = claimSend(sendHour);
    const tickB = claimSend(new Date(2026, 2, 23, 9, 30, 0)); // same hour

    expect(tickA).toBe(true);
    expect(tickB).toBe(false); // blocked — same hour already claimed
  });

  it("allows a send in a different hour after one has been claimed", () => {
    const hour9 = new Date(2026, 2, 23, 9, 0, 0);
    const hour10 = new Date(2026, 2, 23, 10, 0, 0);

    let claimedAt: Date | null = null;

    function claimSend(now: Date): boolean {
      if (claimedAt && isSameHour(claimedAt, now)) return false;
      claimedAt = now;
      return true;
    }

    claimSend(hour9);
    const nextHour = claimSend(hour10);
    expect(nextHour).toBe(true);
  });

  it("markSent before send prevents duplicate even with parallel ticks", async () => {
    let lastSentAt: Date | null = null;
    let sendCount = 0;

    async function tick(now: Date): Promise<void> {
      // isDueNow check (simplified — always due in this test)
      if (lastSentAt && isSameHour(lastSentAt, now)) return;

      // Claim immediately (write-before-send)
      lastSentAt = now;

      // Simulate async send work
      await Promise.resolve();
      sendCount++;
    }

    const now = new Date(2026, 2, 23, 9, 0, 0);
    await Promise.all([tick(now), tick(now)]);
    expect(sendCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Upsert behaviour for digest settings
// ---------------------------------------------------------------------------

describe("upsert behaviour for digest settings", () => {
  type StoredSettings = {
    organizationId: string;
    enabled: boolean;
    dayOfWeek: number;
    hourOfDay: number;
    updatedAt: Date;
  };

  function upsertSettings(
    store: Map<string, StoredSettings>,
    orgId: string,
    patch: Partial<Pick<StoredSettings, "enabled" | "dayOfWeek" | "hourOfDay">>
  ): StoredSettings {
    const existing = store.get(orgId);
    const defaults = { enabled: false, dayOfWeek: 1, hourOfDay: 8 };

    const merged: StoredSettings = existing
      ? {
          ...existing,
          ...(patch.enabled !== undefined && { enabled: patch.enabled }),
          ...(patch.dayOfWeek !== undefined && { dayOfWeek: patch.dayOfWeek }),
          ...(patch.hourOfDay !== undefined && { hourOfDay: patch.hourOfDay }),
          updatedAt: new Date(),
        }
      : {
          organizationId: orgId,
          enabled: patch.enabled ?? defaults.enabled,
          dayOfWeek: patch.dayOfWeek ?? defaults.dayOfWeek,
          hourOfDay: patch.hourOfDay ?? defaults.hourOfDay,
          updatedAt: new Date(),
        };

    store.set(orgId, merged);
    return merged;
  }

  it("creates a new record with supplied values on first PATCH", () => {
    const store = new Map<string, StoredSettings>();
    const result = upsertSettings(store, "org_1", { enabled: true, dayOfWeek: 2, hourOfDay: 10 });

    expect(result.enabled).toBe(true);
    expect(result.dayOfWeek).toBe(2);
    expect(result.hourOfDay).toBe(10);
    expect(store.has("org_1")).toBe(true);
  });

  it("uses defaults for unspecified fields on first PATCH", () => {
    const store = new Map<string, StoredSettings>();
    const result = upsertSettings(store, "org_1", { enabled: true });

    expect(result.dayOfWeek).toBe(1); // default Monday
    expect(result.hourOfDay).toBe(8); // default 8 AM UTC
  });

  it("updates only the specified field without clobbering others", () => {
    const store = new Map<string, StoredSettings>();
    upsertSettings(store, "org_1", { enabled: true, dayOfWeek: 5, hourOfDay: 14 });

    // Patch only hourOfDay
    const result = upsertSettings(store, "org_1", { hourOfDay: 16 });
    expect(result.enabled).toBe(true);   // preserved
    expect(result.dayOfWeek).toBe(5);    // preserved
    expect(result.hourOfDay).toBe(16);   // updated
  });

  it("updates the updatedAt timestamp on each PATCH", async () => {
    const store = new Map<string, StoredSettings>();
    const first = upsertSettings(store, "org_1", { enabled: false });

    // Brief pause to ensure a different timestamp is possible
    await new Promise((r) => setTimeout(r, 2));
    const second = upsertSettings(store, "org_1", { enabled: true });

    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.updatedAt.getTime()
    );
  });

  it("each org has independent settings", () => {
    const store = new Map<string, StoredSettings>();
    upsertSettings(store, "org_1", { enabled: true, dayOfWeek: 1, hourOfDay: 8 });
    upsertSettings(store, "org_2", { enabled: false, dayOfWeek: 5, hourOfDay: 14 });

    const org1 = store.get("org_1")!;
    const org2 = store.get("org_2")!;

    expect(org1.enabled).toBe(true);
    expect(org2.enabled).toBe(false);
    expect(org1.dayOfWeek).not.toBe(org2.dayOfWeek);
  });
});

// ---------------------------------------------------------------------------
// Digest collector data aggregation
// ---------------------------------------------------------------------------

describe("digest collector data aggregation", () => {
  type DeployRow = { status: "success" | "failed" | "running" };
  type BackupRow = { status: "success" | "failed" };
  type CronRunRow = { status: "success" | "failed"; cronJobId: string };

  function aggregateDeploys(rows: DeployRow[]) {
    let total = 0, succeeded = 0, failed = 0;
    for (const row of rows) {
      total++;
      if (row.status === "success") succeeded++;
      if (row.status === "failed") failed++;
    }
    return { total, succeeded, failed };
  }

  function aggregateBackups(rows: BackupRow[]) {
    let total = 0, succeeded = 0, failed = 0;
    for (const row of rows) {
      total++;
      if (row.status === "success") succeeded++;
      if (row.status === "failed") failed++;
    }
    return { total, succeeded, failed };
  }

  function aggregateCronFailures(runs: CronRunRow[]) {
    const failed = runs.filter((r) => r.status === "failed");
    const affectedJobs = [...new Set(failed.map((r) => r.cronJobId))];
    return { totalFailures: failed.length, affectedJobs };
  }

  it("correctly counts deploy totals, successes, and failures", () => {
    const rows: DeployRow[] = [
      { status: "success" },
      { status: "success" },
      { status: "failed" },
      { status: "running" },
    ];
    const result = aggregateDeploys(rows);
    expect(result.total).toBe(4);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("returns zeros for an empty deploy set", () => {
    const result = aggregateDeploys([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
  });

  it("correctly counts backup totals, successes, and failures", () => {
    const rows: BackupRow[] = [
      { status: "success" },
      { status: "failed" },
      { status: "failed" },
    ];
    const result = aggregateBackups(rows);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
  });

  it("returns zeros for an empty backup set", () => {
    const result = aggregateBackups([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
  });

  it("counts total cron failures and deduplicated affected jobs", () => {
    const runs: CronRunRow[] = [
      { status: "failed", cronJobId: "job_1" },
      { status: "failed", cronJobId: "job_1" }, // same job — deduplicated
      { status: "failed", cronJobId: "job_2" },
      { status: "success", cronJobId: "job_3" },
    ];
    const result = aggregateCronFailures(runs);
    expect(result.totalFailures).toBe(3);
    expect(result.affectedJobs).toHaveLength(2);
    expect(result.affectedJobs).toContain("job_1");
    expect(result.affectedJobs).toContain("job_2");
  });

  it("returns empty cron summary when all runs succeed", () => {
    const runs: CronRunRow[] = [
      { status: "success", cronJobId: "job_1" },
    ];
    const result = aggregateCronFailures(runs);
    expect(result.totalFailures).toBe(0);
    expect(result.affectedJobs).toHaveLength(0);
  });
});
