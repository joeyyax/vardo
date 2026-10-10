import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

import { dbMock } from "@/tests/helpers/db";
const { resolveSettings, updateOrgNotificationSettings } = await import("@/lib/notifications/preferences");

describe("org notification settings", () => {
  beforeEach(() => dbMock.reset());

  it("defaults every category on with a 30 minute batch window", () => {
    expect(resolveSettings(null)).toEqual({ categories: { backups: true, host: true, apps: true }, batchWindowMinutes: 30 });
  });

  it("drops keys no category has", () => {
    expect(resolveSettings({ categories: { host: false, retired: false }, batchWindowMinutes: 60 }).categories).toEqual({
      backups: true,
      host: false,
      apps: true,
    });
  });

  it("stores only what differs from the defaults", async () => {
    dbMock.query.notificationSettings.findFirst.mockResolvedValue({ categories: { host: false }, batchWindowMinutes: 30 });
    const next = await updateOrgNotificationSettings("org1", { categories: { host: true, backups: false } });
    expect(dbMock.inserts[0].values).toMatchObject({ categories: { backups: false }, batchWindowMinutes: 30 });
    expect(next.categories).toEqual({ backups: false, host: true, apps: true });
  });
});
