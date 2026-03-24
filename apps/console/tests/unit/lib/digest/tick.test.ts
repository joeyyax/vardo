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
});

// ---------------------------------------------------------------------------
// Digest collector data aggregation
// ---------------------------------------------------------------------------

describe("digest collector data aggregation", () => {
  type DeployRow = { status: "success" | "failed" | "running" };
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
});
