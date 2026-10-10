import { describe, it, expect } from "vitest";
import { evaluateGates, UPDATE_MIN_FREE_BYTES, type GateInputs } from "@/lib/self-update/gates";

const GB = 1024 ** 3;

const clear: GateInputs = {
  activeDeploys: 0,
  runningBackups: 0,
  runningRestores: 0,
  runningDrills: 0,
  disk: { freeBytes: 50 * GB, usedBytes: 50 * GB },
  unhealthyServices: [],
  targetFailedBefore: false,
};

describe("evaluateGates", () => {
  it("passes a quiet, healthy instance with room", () => {
    expect(evaluateGates(clear)).toEqual([]);
  });

  it("names everything in progress in one busy reason", () => {
    const failures = evaluateGates({ ...clear, activeDeploys: 2, runningBackups: 1, runningRestores: 1, runningDrills: 1 });
    expect(failures).toEqual([
      { gate: "busy", reason: "Busy: 2 deploys in progress, 1 backup running, a restore running, 1 restore drill running" },
    ]);
  });

  it("needs free space and headroom", () => {
    expect(evaluateGates({ ...clear, disk: { freeBytes: UPDATE_MIN_FREE_BYTES - 1, usedBytes: 10 * GB } })[0].gate).toBe("disk");
    expect(evaluateGates({ ...clear, disk: { freeBytes: 20 * GB, usedBytes: 380 * GB } })[0].gate).toBe("disk");
  });

  it("passes an unreadable disk", () => {
    expect(evaluateGates({ ...clear, disk: null })).toEqual([]);
  });

  it("refuses an unhealthy instance and a target that already failed here", () => {
    const failures = evaluateGates({ ...clear, unhealthyServices: ["Redis"], targetFailedBefore: true });
    expect(failures.map((f) => f.gate)).toEqual(["health", "failed-before"]);
    expect(failures[0].reason).toBe("Unhealthy: Redis");
  });
});
