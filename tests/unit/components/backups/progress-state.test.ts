// The backups page folds bus events into a per-job "in flight" map. A run that
// never clears would leave the card spinning forever, so the terminal events
// have to remove it.

import { describe, it, expect } from "vitest";
import { applyBackupEvent } from "@/components/backups/progress-state";
import type { BusEvent } from "@/lib/bus/events";

function progress(overrides: Partial<Extract<BusEvent, { type: "backup.progress" }>> = {}): BusEvent {
  return {
    type: "backup.progress",
    title: "Backing up immich",
    message: "immich (3 of 11)",
    jobId: "job-1",
    jobName: "Nightly",
    appId: "app-1",
    appName: "immich",
    volumeName: "data",
    index: 3,
    total: 11,
    ...overrides,
  };
}

describe("applyBackupEvent", () => {
  it("tracks the source a job is on", () => {
    const state = applyBackupEvent({}, progress());

    expect(state["job-1"]).toEqual({
      jobId: "job-1",
      appName: "immich",
      volumeName: "data",
      index: 3,
      total: 11,
    });
  });

  it("advances a job in place and keeps other jobs running", () => {
    const first = applyBackupEvent({}, progress({ jobId: "job-2", appName: "loki", index: 1 }));
    const second = applyBackupEvent(first, progress());
    const third = applyBackupEvent(second, progress({ appName: "lonvr", index: 4 }));

    expect(Object.keys(third)).toEqual(["job-2", "job-1"]);
    expect(third["job-1"]).toMatchObject({ appName: "lonvr", index: 4 });
  });

  it("clears the job when the run finishes", () => {
    const running = applyBackupEvent({}, progress());

    const done = applyBackupEvent(running, {
      type: "backup.success",
      title: "Backup successful",
      message: "",
      jobId: "job-1",
      jobName: "Nightly",
      totalCount: 11,
      totalSize: 1024,
    });

    expect(done).toEqual({});
  });

  it("clears the job when the run fails", () => {
    const running = applyBackupEvent({}, progress());

    const done = applyBackupEvent(running, {
      type: "backup.failed",
      title: "Backup failed",
      message: "",
      jobId: "job-1",
      jobName: "Nightly",
      failedCount: 1,
      totalCount: 11,
      errors: "data: nope",
    });

    expect(done).toEqual({});
  });

  it("leaves the map untouched for unrelated events", () => {
    const running = applyBackupEvent({}, progress());

    const after = applyBackupEvent(running, {
      type: "app.state-changed",
      title: "App state changed",
      message: "",
      appId: "app-1",
    });

    expect(after).toBe(running);
  });
});
