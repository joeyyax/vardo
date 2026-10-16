import { describe, expect, it } from "vitest";
import { jobRetentionDays, recoveryPointHours, resolveCommitments, retentionDays, validAmount, type CommitmentFacts, type RetentionRule } from "@/lib/trust/commitments";

const facts: CommitmentFacts = { recoveryPointHours: 24, retentionDays: 30, autoUpdate: true };
const byId = (list: ReturnType<typeof resolveCommitments>, id: string) => list.find((c) => c.id === id)!;

describe("resolveCommitments", () => {
  it("starts recovery point, retention and patches on, with values from settings", () => {
    const list = resolveCommitments({}, facts);
    expect(byId(list, "recovery-point")).toMatchObject({ enabled: true, value: "24 hours" });
    expect(byId(list, "backup-retention")).toMatchObject({ enabled: true, value: "30 days" });
    expect(byId(list, "security-patches")).toMatchObject({ enabled: true, value: "Applied automatically" });
  });

  it("keeps patches off while automatic updates are off, even if switched on", () => {
    const patches = byId(resolveCommitments({ "security-patches": { enabled: true } }, { ...facts, autoUpdate: false }), "security-patches");
    expect(patches).toMatchObject({ enabled: false, locked: true, value: null });
  });

  it("keeps the other six off until the operator turns them on and sets a value", () => {
    const manual = ["uptime", "recovery-time", "breach-notification", "maintenance-notice", "support-response", "data-deletion"];
    const list = resolveCommitments({}, facts);
    for (const id of manual) expect(byId(list, id)).toMatchObject({ enabled: false, value: null });
    const withoutValue = byId(resolveCommitments({ uptime: { enabled: true } }, facts), "uptime");
    expect(withoutValue).toMatchObject({ enabled: true, value: null, blocker: "Set a value to publish it." });
    const set = byId(resolveCommitments({ uptime: { enabled: true, amount: 99.9 } }, facts), "uptime");
    expect(set.value).toBe("99.9% monthly");
  });

  it("publishes nothing for a value settings can't give", () => {
    const list = resolveCommitments({}, { ...facts, retentionDays: null, recoveryPointHours: null });
    expect(byId(list, "backup-retention").value).toBeNull();
    expect(byId(list, "recovery-point").value).toBeNull();
  });

  it("ignores a stored value that fails validation", () => {
    expect(byId(resolveCommitments({ uptime: { enabled: true, amount: 12 } }, facts), "uptime").value).toBeNull();
  });

  it("writes durations the way a person would", () => {
    const list = resolveCommitments({ "breach-notification": { enabled: true, amount: 72 }, "maintenance-notice": { enabled: true, amount: 1 }, "data-deletion": { enabled: true, amount: 30 } }, facts);
    expect(byId(list, "breach-notification").value).toBe("Within 3 days");
    expect(byId(list, "maintenance-notice").value).toBe("1 hour ahead");
    expect(byId(list, "data-deletion").value).toBe("Within 30 days");
  });
});

describe("validAmount", () => {
  it("bounds each commitment and rejects fractions where they make no sense", () => {
    const uptime = { min: 90, max: 100, unit: "percent" as const };
    expect(validAmount(uptime, 99.95)).toBe(true);
    expect(validAmount(uptime, 99.999)).toBe(false);
    expect(validAmount(uptime, 101)).toBe(false);
    const hours = { min: 1, max: 100, unit: "hours" as const };
    expect(validAmount(hours, 4)).toBe(true);
    expect(validAmount(hours, 4.5)).toBe(false);
    expect(validAmount(hours, 0)).toBe(false);
    expect(validAmount(hours, NaN)).toBe(false);
  });
});

const rule = (over: Partial<RetentionRule>): RetentionRule => ({
  keepAll: false,
  keepLast: null,
  keepHourly: null,
  keepDaily: null,
  keepWeekly: null,
  keepMonthly: null,
  keepYearly: null,
  intervalMs: 86_400_000,
  ...over,
});

describe("retention", () => {
  it("takes the widest rule within a job", () => {
    expect(jobRetentionDays(rule({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }))).toBe(180);
  });

  it("derives keep-last from the schedule", () => {
    expect(jobRetentionDays(rule({ keepLast: 14 }))).toBe(14);
    expect(jobRetentionDays(rule({ keepLast: 14, intervalMs: null }))).toBeNull();
  });

  it("states the shortest job so the claim holds for all of them", () => {
    expect(retentionDays([rule({ keepDaily: 30 }), rule({ keepDaily: 7 })])).toBe(7);
  });

  it("says nothing when a job has no rule, and ignores keep-all jobs", () => {
    expect(retentionDays([rule({ keepDaily: 30 }), rule({})])).toBeNull();
    expect(retentionDays([rule({ keepDaily: 30 }), rule({ keepAll: true })])).toBe(30);
    expect(retentionDays([rule({ keepAll: true })])).toBeNull();
    expect(retentionDays([])).toBeNull();
  });
});

describe("recoveryPointHours", () => {
  it("is the longest gap, rounded up", () => {
    expect(recoveryPointHours([86_400_000, 3_600_000])).toBe(24);
    expect(recoveryPointHours([90 * 60_000])).toBe(2);
  });

  it("is null without jobs or when a schedule can't be read", () => {
    expect(recoveryPointHours([])).toBeNull();
    expect(recoveryPointHours([86_400_000, null])).toBeNull();
  });
});
