import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

import { dbMock } from "@/tests/helpers/db";
const { resolveCategories, updateOrgNotificationSettings } = await import("@/lib/notifications/preferences");

describe("org notification settings", () => {
  beforeEach(() => dbMock.reset());

  it("defaults every category on", () => {
    expect(resolveCategories(null)).toEqual({ backups: true, backupStarts: true, host: true, apps: true, cron: true });
  });

  it("drops keys no category has", () => {
    expect(resolveCategories({ host: false, retired: false })).toEqual({ backups: true, backupStarts: true, host: false, apps: true, cron: true });
  });

  it("stores only what differs from the defaults", async () => {
    dbMock.query.notificationSettings.findFirst.mockResolvedValue({ categories: { host: false } });
    dbMock.query.organizations.findFirst.mockResolvedValue({ nightlyBackupTime: "02:00" });
    const next = await updateOrgNotificationSettings("org1", { categories: { host: true, backups: false } });
    expect(dbMock.inserts[0].values).toMatchObject({ categories: { backups: false } });
    expect(next.categories).toEqual({ backups: false, backupStarts: true, host: true, apps: true, cron: true });
  });

  it("moves every nightly job when the time changes", async () => {
    dbMock.query.notificationSettings.findFirst.mockResolvedValue(undefined);
    dbMock.query.organizations.findFirst.mockResolvedValue({ nightlyBackupTime: "02:00" });
    await updateOrgNotificationSettings("org1", { nightlyBackupTime: "03:30" });
    expect(dbMock.updates.map((u) => u.set)).toEqual([
      { nightlyBackupTime: "03:30" },
      expect.objectContaining({ schedule: "30 3 * * *" }),
    ]);
  });
});
