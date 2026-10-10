import { tickBackupJobs, tickRestoreDrills } from "./tick";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("backup");

// Drills run hourly.
const DRILL_TICK_MS = 60 * 60_000;

/** How often to look for backups a stopped console cut off. */
const SWEEP_TICK_MS = 5 * 60_000;

// Each pass waits on the backups it starts, so a slow one can't hold back the next minute.
export const backupTickLoop = new IntervalLoop({
  name: "backup-tick",
  intervalMs: 60_000,
  overlap: true,
  log,
  run: () => tickBackupJobs(),
});

// Own loop: the backup tick waits on its jobs.
export const backupRunFinishLoop = new IntervalLoop({
  name: "backup-run-finish",
  intervalMs: 60_000,
  log,
  run: async () => {
    const { finishBackupRuns } = await import("./runs");
    await finishBackupRuns();
  },
});

// Own loop, so a slow drill can't delay a backup.
export const restoreDrillLoop = new IntervalLoop({
  name: "restore-drill",
  intervalMs: DRILL_TICK_MS,
  log,
  run: () => tickRestoreDrills(),
});

// Picks up what the last console left: at start, and after a self-deploy's old slot stops.
export const backupRequeueLoop = new IntervalLoop({
  name: "backup-requeue",
  intervalMs: SWEEP_TICK_MS,
  firstRunMs: 0,
  log,
  run: async () => {
    const { sweepInterruptedBackups } = await import("./requeue");
    await sweepInterruptedBackups();
  },
});
