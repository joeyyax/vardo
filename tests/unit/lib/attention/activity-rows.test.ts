import { describe, it, expect } from "vitest";

import { activityRows } from "@/lib/attention/activity-rows";

const alpha = { id: "app-alpha", name: "alpha", displayName: "Alpha" };
const beta = { id: "app-beta", name: "beta", displayName: "Beta" };

describe("activityRows", () => {
  it("returns nothing when there is no activity", () => {
    expect(activityRows([alpha], { deployments: [], backups: [] })).toEqual([]);
  });

  it("builds a deploying row from running deployments", () => {
    const rows = activityRows([alpha], {
      deployments: [
        { id: "d1", appId: "app-alpha", gitSha: "abc1234def", startedAt: new Date("2026-08-01T00:00:00Z") },
      ],
      backups: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "deploying", tone: "activity" });
    expect(rows[0].items[0]).toMatchObject({
      name: "Alpha",
      href: "/apps/alpha/deployments",
      detail: "abc1234",
    });
  });

  it("builds a backup-running row from running backups", () => {
    const rows = activityRows([beta], {
      deployments: [],
      backups: [{ id: "b1", appId: "app-beta", startedAt: new Date("2026-08-01T00:00:00Z") }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "backup-running", tone: "activity" });
    expect(rows[0].items[0]).toMatchObject({ name: "Beta", href: "/apps/beta/backups" });
  });

  it("keeps deploying and backup-running as separate rows", () => {
    const rows = activityRows([alpha, beta], {
      deployments: [{ id: "d1", appId: "app-alpha", gitSha: null, startedAt: new Date() }],
      backups: [{ id: "b1", appId: "app-beta", startedAt: new Date() }],
    });

    expect(rows.map((r) => r.key)).toEqual(["deploying", "backup-running"]);
  });

  it("keeps only the latest deployment per app", () => {
    const rows = activityRows([alpha], {
      deployments: [
        { id: "newer", appId: "app-alpha", gitSha: null, startedAt: new Date("2026-08-01T12:00:00Z") },
        { id: "older", appId: "app-alpha", gitSha: null, startedAt: new Date("2026-08-01T00:00:00Z") },
      ],
      backups: [],
    });

    expect(rows[0].items).toHaveLength(1);
    expect(rows[0].items[0].id).toBe("newer");
  });

  it("drops activity for an app that no longer exists", () => {
    const rows = activityRows([alpha], {
      deployments: [{ id: "d1", appId: "app-gone", gitSha: null, startedAt: new Date() }],
      backups: [],
    });

    expect(rows).toEqual([]);
  });
});
