import { describe, expect, it } from "vitest";
import { splitPausedDumps, stoppedBackupRow } from "@/lib/attention/backup-stopped-row";

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

  it("lists an app once per job when it is both past due and waiting on a dump", () => {
    const entry = { job: job("j1", "Reeve NVR"), lastBackupAt: null, apps: [{ id: "a1", name: "lonvr", displayName: "Reeve NVR" }] };
    expect(stoppedBackupRow([entry, entry], "UTC")?.items).toHaveLength(1);
  });
});

describe("splitPausedDumps", () => {
  const ran = new Date("2026-08-01");
  const row = (id: string, state: Record<string, unknown>, jobId = "j1") => ({
    id, name: id, displayName: id, jobId, jobName: `Auto: ${id}`, lastRunAt: ran, status: "stopped", parked: false, lastRunningAt: ran, ...state,
  });

  it("holds a dump for an app stopped on purpose and pauses one for an app that crashed or vanished", () => {
    const { paused, onHold } = splitPausedDumps([
      row("lonvr", { status: "missing", parked: true }),
      row("jellyfin", { status: "stopped", exitReason: { signal: "SIGTERM" } }),
      row("db", { status: "error" }),
      row("gone", { status: "missing" }),
      row("segv", { status: "stopped", exitReason: { signal: "SIGSEGV" } }),
    ]);
    expect(onHold.map((h) => h.apps[0].id)).toEqual(["lonvr", "jellyfin"]);
    expect(paused.map((p) => p.id)).toEqual(["db", "gone", "segv"]);
  });

  it("pauses an app once across its jobs", () => {
    expect(splitPausedDumps([row("db", { status: "error" }), row("db", { status: "error" }, "j2")]).paused).toHaveLength(1);
  });
});
