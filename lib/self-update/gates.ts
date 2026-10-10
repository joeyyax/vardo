// Checks an automatic update must pass before it starts. Pure: the runner collects the inputs.

import { formatBytes } from "@/lib/metrics/format";

export type GateInputs = {
  /** Deployments queued or running on any app, imports included. */
  activeDeploys: number;
  runningBackups: number;
  runningRestores: number;
  runningDrills: number;
  /** Free and usable bytes on Docker's disk. Null when unreadable. */
  disk: { freeBytes: number; usedBytes: number } | null;
  /** Core services the health probe reports unhealthy. */
  unhealthyServices: string[];
  /** The target already failed here and was rolled back. */
  targetFailedBefore: boolean;
};

export type GateName = "busy" | "disk" | "health" | "failed-before" | "backup";

export type GateFailure = { gate: GateName; reason: string };

/** A build, the new slot and the dump all need room. */
export const UPDATE_MIN_FREE_BYTES = 5 * 1024 ** 3;
export const UPDATE_MAX_USED_PERCENT = 90;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function evaluateGates(inputs: GateInputs): GateFailure[] {
  const failures: GateFailure[] = [];

  const busy = [
    inputs.activeDeploys > 0 && `${count(inputs.activeDeploys, "deploy", "deploys")} in progress`,
    inputs.runningBackups > 0 && `${count(inputs.runningBackups, "backup", "backups")} running`,
    inputs.runningRestores > 0 && "a restore running",
    inputs.runningDrills > 0 && `${count(inputs.runningDrills, "restore drill", "restore drills")} running`,
  ].filter((s): s is string => typeof s === "string");
  if (busy.length > 0) failures.push({ gate: "busy", reason: `Busy: ${busy.join(", ")}` });

  if (inputs.disk) {
    const usable = inputs.disk.usedBytes + inputs.disk.freeBytes;
    const usedPercent = usable > 0 ? (inputs.disk.usedBytes / usable) * 100 : 0;
    if (inputs.disk.freeBytes < UPDATE_MIN_FREE_BYTES || usedPercent >= UPDATE_MAX_USED_PERCENT) {
      failures.push({
        gate: "disk",
        reason: `Low disk: ${formatBytes(inputs.disk.freeBytes)} free, ${Math.floor(usedPercent)}% used (needs ${formatBytes(UPDATE_MIN_FREE_BYTES)} and under ${UPDATE_MAX_USED_PERCENT}%)`,
      });
    }
  }

  if (inputs.unhealthyServices.length > 0) {
    failures.push({ gate: "health", reason: `Unhealthy: ${inputs.unhealthyServices.join(", ")}` });
  }

  if (inputs.targetFailedBefore) {
    failures.push({ gate: "failed-before", reason: "This version failed its health check here and was rolled back" });
  }

  return failures;
}
