import { describe, it, expect } from "vitest";

import { standingBackupFailures, type BackupOutcome } from "@/lib/attention/backup-failures";
import { NOT_REQUEUED_NOTE, REQUEUED_NOTE, SUPERSEDED_REASON } from "@/lib/backups/requeue-notes";
import { INTERRUPTED_REASON } from "@/lib/backups/reap";

let n = 0;
function outcome(over: Partial<BackupOutcome> & { appId: string; status: string; hoursAgo: number }): BackupOutcome {
  const { hoursAgo, ...rest } = over;
  return {
    id: `b${++n}`,
    jobId: "job-1",
    volumeName: "data",
    log: null,
    startedAt: new Date(Date.parse("2026-10-10T12:00:00.000Z") - hoursAgo * 3_600_000),
    ...rest,
  };
}

const ids = (rows: BackupOutcome[]) => rows.map((r) => r.appId).sort();

describe("standingBackupFailures", () => {
  it("counts a failure that is still the latest outcome", () => {
    expect(ids(standingBackupFailures([outcome({ appId: "gitea", status: "failed", hoursAgo: 6 })]))).toEqual(["gitea"]);
  });

  // Overnight failures that succeeded on a rerun five hours later.
  it("clears a failure a later success replaced", () => {
    const rows = [
      outcome({ appId: "transmission", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "transmission", status: "success", hoursAgo: 5 }),
      outcome({ appId: "gitea", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "gitea", status: "success", hoursAgo: 5 }),
      outcome({ appId: "immich", status: "failed", hoursAgo: 10 }),
    ];
    expect(ids(standingBackupFailures(rows))).toEqual(["immich"]);
  });

  it("counts a failure that came after a success", () => {
    const rows = [
      outcome({ appId: "gitea", status: "success", hoursAgo: 10 }),
      outcome({ appId: "gitea", status: "failed", hoursAgo: 5 }),
    ];
    expect(ids(standingBackupFailures(rows))).toEqual(["gitea"]);
  });

  it("clears a failure once a later run is under way", () => {
    const rows = [
      outcome({ appId: "gitea", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "gitea", status: "running", hoursAgo: 1 }),
    ];
    expect(standingBackupFailures(rows)).toEqual([]);
  });

  it("judges each volume on its own", () => {
    const rows = [
      outcome({ appId: "immich", volumeName: "db", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "immich", volumeName: "photos", status: "success", hoursAgo: 5 }),
    ];
    expect(ids(standingBackupFailures(rows))).toEqual(["immich"]);
  });

  it("ignores a skipped source, which says nothing about the failure", () => {
    const rows = [
      outcome({ appId: "gitea", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "gitea", status: "skipped", hoursAgo: 5 }),
    ];
    expect(ids(standingBackupFailures(rows))).toEqual(["gitea"]);
  });

  it("drops an interrupted run that was requeued or superseded", () => {
    const interrupted = (note: string) => `${INTERRUPTED_REASON}\n${note}`;
    const rows = [
      outcome({ appId: "gitea", status: "failed", hoursAgo: 3, log: interrupted(REQUEUED_NOTE) }),
      outcome({ appId: "immich", status: "failed", hoursAgo: 3, log: interrupted(`${NOT_REQUEUED_NOTE}: ${SUPERSEDED_REASON}`) }),
    ];
    expect(standingBackupFailures(rows)).toEqual([]);
  });

  it("keeps an interrupted run nothing reran", () => {
    const rows = [
      outcome({
        appId: "gitea",
        status: "failed",
        hoursAgo: 3,
        log: `${INTERRUPTED_REASON}\n${NOT_REQUEUED_NOTE}: the job is off or gone`,
      }),
    ];
    expect(ids(standingBackupFailures(rows))).toEqual(["gitea"]);
  });

  it("reports one failure per app, the most recent", () => {
    const rows = [
      outcome({ appId: "immich", volumeName: "db", status: "failed", hoursAgo: 10 }),
      outcome({ appId: "immich", volumeName: "photos", status: "failed", hoursAgo: 4 }),
    ];
    const [only, ...rest] = standingBackupFailures(rows);
    expect(rest).toEqual([]);
    expect(only.volumeName).toBe("photos");
  });
});
