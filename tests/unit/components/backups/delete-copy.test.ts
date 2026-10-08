// Delete confirmations name what goes with a target or backup (#872).

import { describe, it, expect } from "vitest";
import { deleteDescription, orphanScope, usageSummary } from "@/components/backups/delete-copy";
import type { RecentBackup } from "@/components/backups/types";

const backup: RecentBackup = {
  id: "b-1",
  status: "success",
  sizeBytes: 2048,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
  storagePath: "org/web/data.tar.gz",
  log: null,
  verifiedAt: null,
  verifyOutcome: null,
  verifyDetail: null,
  job: { id: "job-1", name: "Nightly" },
  jobName: "Nightly",
  appId: "app-1",
  app: { id: "app-1", name: "web", displayName: "Web" },
  appName: "web",
};

describe("target delete confirmation", () => {
  it("names the backups, their size and the jobs", () => {
    expect(
      usageSummary({ backups: 12, bytes: 2048, inProgress: 0, jobs: 2, jobNames: ["Nightly", "Weekly"] }, false),
    ).toBe(
      "Also deletes 12 backups with their 2 KB of archives in storage, and 2 backup jobs: Nightly, Weekly. This can't be undone.",
    );
  });

  it("says an instance target reaches every org", () => {
    expect(usageSummary({ backups: 1, bytes: 0, inProgress: 0, jobs: 0, jobNames: [] }, true)).toMatch(
      /across every organization/,
    );
  });
});

describe("backup delete confirmation", () => {
  it("names the app and the archive", () => {
    expect(deleteDescription(backup)).toMatch(/backup of Web and its archive \(2 KB\) from storage/);
  });

  it("leaves out storage for a pruned backup", () => {
    expect(deleteDescription({ ...backup, status: "pruned" })).not.toMatch(/storage/);
  });

  it("offers a deleted app's whole history", () => {
    expect(orphanScope({ ...backup, app: null })).toEqual({ query: "appId=app-1", label: "web" });
  });

  it("offers a deleted job's whole history", () => {
    expect(orphanScope({ ...backup, job: null })).toEqual({
      query: "jobName=Nightly",
      label: "the deleted job Nightly",
    });
  });

  it("offers nothing more for a live app and job", () => {
    expect(orphanScope(backup)).toBeNull();
  });
});
