import { describe, expect, it } from "vitest";
import { stoppedBackupRow } from "@/lib/attention/backup-stopped-row";

const job = (id: string, name: string) => ({ id, name, schedule: "0 3 * * *", enabled: true, lastRunAt: null, createdAt: new Date() });

describe("stoppedBackupRow", () => {
  it("lists each stopped app at neutral tone with its last backup in the org's zone", () => {
    const row = stoppedBackupRow(
      [
        { job: job("j1", "Reeve NVR"), lastBackupAt: new Date("2026-08-02T05:00:00Z"), apps: [{ id: "a1", name: "lonvr", displayName: "Reeve NVR" }] },
        { job: job("j2", "Restream"), lastBackupAt: null, apps: [] },
      ],
      "America/Los_Angeles",
    );
    expect(row).toMatchObject({ key: "backup-app-stopped", tone: "neutral" });
    expect(row?.group).toBeUndefined();
    expect(row?.items).toEqual([
      { id: "j1:a1", subject: "a1", name: "Reeve NVR", href: "/apps/lonvr/backups", detail: "App stopped · last backup Aug 1" },
      { id: "j2", name: "Restream", href: "/backups", detail: "App stopped · never backed up" },
    ]);
  });

  it("is absent with nothing stopped", () => expect(stoppedBackupRow([], "UTC")).toBeNull());
});
