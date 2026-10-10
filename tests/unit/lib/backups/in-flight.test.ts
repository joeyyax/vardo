// A self-deploy stopped the console mid-backup. The stop now waits for backup work, up to a bound.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  backupDrainTimeoutMs,
  backupsDraining,
  backupWorkInFlight,
  drainBackupsForStop,
  endBackupDrain,
  resetBackupWorkForTests,
  trackBackupWork,
} from "@/lib/backups/in-flight";
import { backupSlotsBusy, withBackupSlot } from "@/lib/backups/run-limit";

function held<T = void>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => (release = r));
  return { promise, release };
}

beforeEach(() => resetBackupWorkForTests());

describe("trackBackupWork", () => {
  it("lists work while it runs and drops it once settled, failures included", async () => {
    const gate = held();
    const run = trackBackupWork("backup", "job job-1", () => gate.promise);
    expect(backupWorkInFlight()).toMatchObject([{ kind: "backup", label: "job job-1" }]);

    gate.release();
    await run;
    expect(backupWorkInFlight()).toEqual([]);

    await expect(trackBackupWork("restore", "of backup b-1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(backupWorkInFlight()).toEqual([]);
  });
});

describe("drainBackupsForStop", () => {
  it("returns at once with nothing running", async () => {
    expect(await drainBackupsForStop(() => {}, 1000, 5)).toEqual([]);
    expect(backupsDraining()).toBe(true);
  });

  it("waits for a running backup, naming it in the deploy log", async () => {
    const gate = held();
    const run = trackBackupWork("backup", "job job-1", () => gate.promise);
    const lines: string[] = [];
    let done = false;
    const drain = drainBackupsForStop((l) => lines.push(l), 5_000, 5).then((left) => {
      done = true;
      return left;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(lines[0]).toContain("backup job job-1");

    gate.release();
    await run;
    expect(await drain).toEqual([]);
    expect(lines.at(-1)).toContain("finished");
  });

  it("waits for jobs still queued for a slot", async () => {
    const first = held();
    const second = held();
    const a = withBackupSlot(1, () => trackBackupWork("backup", "job a", () => first.promise));
    const b = withBackupSlot(1, () => trackBackupWork("backup", "job b", () => second.promise));
    const drain = drainBackupsForStop(() => {}, 5_000, 5);

    first.release();
    await a;
    await new Promise((r) => setTimeout(r, 20));
    expect(backupWorkInFlight().map((w) => w.label)).toEqual(["job b"]);

    second.release();
    await b;
    expect(await drain).toEqual([]);
    expect(backupSlotsBusy()).toBe(false);
  });

  it("gives up at the deadline and names what it cut off", async () => {
    void trackBackupWork("drill", "of backup b-9", () => new Promise(() => {}));

    expect(await drainBackupsForStop(() => {}, 30, 5)).toEqual(["drill of backup b-9"]);
  });

  it("takes schedules again after a stop that didn't happen", async () => {
    await drainBackupsForStop(() => {}, 0, 5);
    endBackupDrain();
    expect(backupsDraining()).toBe(false);
  });
});

describe("backupDrainTimeoutMs", () => {
  it("defaults to 20 minutes and reads VARDO_BACKUP_DRAIN_MINUTES", () => {
    expect(backupDrainTimeoutMs({})).toBe(20 * 60_000);
    expect(backupDrainTimeoutMs({ VARDO_BACKUP_DRAIN_MINUTES: "45" })).toBe(45 * 60_000);
    expect(backupDrainTimeoutMs({ VARDO_BACKUP_DRAIN_MINUTES: "0" })).toBe(0);
    expect(backupDrainTimeoutMs({ VARDO_BACKUP_DRAIN_MINUTES: "soon" })).toBe(20 * 60_000);
  });
});
