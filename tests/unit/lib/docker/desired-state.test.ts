import { describe, it, expect } from "vitest";

import {
  EXIT_SETTLE_MS,
  decideDesiredState,
  intendedStopReason,
  keepsRunning,
  projectSlot,
  resolvePriority,
  type StopIntent,
} from "@/lib/docker/desired-state";

const T = 1_000_000_000;
const MIN = 60_000;

// Scrypted at 03:41:18 on 2026-09-30: current blue slot, unless-stopped, 137.
const scrypted: StopIntent = {
  status: "exited",
  exitCode: 137,
  restartPolicy: "unless-stopped",
  startedAt: T - 60 * 24 * 60 * MIN,
  appStatus: "active",
  parked: false,
  operatorStoppedAt: null,
  heldBy: null,
  slot: "blue",
  currentSlot: "blue",
  siblingRunning: false,
};

const decide = (intendedStop: string | null, extra: Partial<Parameters<typeof decideDesiredState>[0]> = {}) =>
  decideDesiredState({
    intendedStop,
    finishedAt: T,
    recentRestarts: [],
    gaveUp: false,
    maxRestarts: 5,
    backoffMs: 5 * MIN,
    now: T + 2 * MIN,
    ...extra,
  });

describe("intendedStopReason", () => {
  it("finds nothing that asked the incident container to stop", () => {
    expect(intendedStopReason(scrypted)).toBeNull();
  });

  it("honors an operator stop after the container last started", () => {
    expect(intendedStopReason({ ...scrypted, operatorStoppedAt: T - MIN })).toBe("stopped by an operator");
  });

  it("ignores an operator stop from before the container last started", () => {
    expect(intendedStopReason({ ...scrypted, operatorStoppedAt: scrypted.startedAt! - 1 })).toBeNull();
  });

  it("leaves a parked app stopped", () => {
    expect(intendedStopReason({ ...scrypted, parked: true })).toBe("app is parked");
  });

  it("yields to a deploy in flight", () => {
    expect(intendedStopReason({ ...scrypted, appStatus: "deploying" })).toBe("a deploy owns the app");
  });

  it("leaves the old blue/green slot stopped", () => {
    expect(intendedStopReason({ ...scrypted, slot: "green", currentSlot: "blue" })).toBe(
      "green is not the current slot",
    );
  });

  it("refuses a slotted container when the current slot cannot be read", () => {
    expect(intendedStopReason({ ...scrypted, currentSlot: null })).toBe("no current slot to compare");
  });

  it("treats shared and unslotted containers as current", () => {
    expect(intendedStopReason({ ...scrypted, slot: "shared", currentSlot: null })).toBeNull();
    expect(intendedStopReason({ ...scrypted, slot: null, currentSlot: null })).toBeNull();
  });

  it("leaves a demoted standby or one-shot service stopped", () => {
    expect(intendedStopReason({ ...scrypted, restartPolicy: "no" })).toBe("restart policy is no");
    expect(intendedStopReason({ ...scrypted, restartPolicy: "" })).toBe("restart policy is no");
  });

  it("leaves a clean exit alone unless Vardo's own restart caused it", () => {
    expect(intendedStopReason({ ...scrypted, exitCode: 0 })).toBe("exited cleanly");
    expect(intendedStopReason({ ...scrypted, exitCode: 0 }, true)).toBeNull();
  });

  it("leaves a container a restore is holding", () => {
    expect(intendedStopReason({ ...scrypted, heldBy: "restore" })).toBe("held by restore");
  });

  it("leaves a container whose service is already running elsewhere", () => {
    expect(intendedStopReason({ ...scrypted, siblingRunning: true })).toBe("another container is serving");
  });

  it("only judges stopped containers", () => {
    expect(intendedStopReason({ ...scrypted, status: "running" })).toBe("container is running");
  });
});

describe("decideDesiredState", () => {
  it("starts the incident container once its exit settles", () => {
    expect(decide(intendedStopReason(scrypted), { now: T + EXIT_SETTLE_MS - 1 })).toBe("settle");
    expect(decide(intendedStopReason(scrypted), { now: T + EXIT_SETTLE_MS })).toBe("start");
  });

  it("leaves an intended stop whatever the budget says", () => {
    expect(decide("app is parked")).toBe("leave");
  });

  it("backs off after a start inside the backoff window", () => {
    expect(decide(null, { recentRestarts: [T + MIN] })).toBe("backoff");
  });

  it("gives up once failed starts use the hourly budget", () => {
    const spent = [T - 50 * MIN, T - 40 * MIN, T - 30 * MIN, T - 20 * MIN, T - 10 * MIN];
    expect(decide(null, { recentRestarts: spent })).toBe("giveup");
  });

  it("stays quiet after giving up", () => {
    expect(decide(null, { gaveUp: true })).toBe("leave");
  });

  it("waits when the exit time is unknown", () => {
    expect(decide(null, { finishedAt: null })).toBe("settle");
  });
});

describe("projectSlot", () => {
  it("reads the slot off a generated project name", () => {
    expect(projectSlot("scrypted-production-blue")).toBe("blue");
    expect(projectSlot("paperless-pr-7-green")).toBe("green");
    expect(projectSlot("paperless-production-shared")).toBe("shared");
  });

  it("returns null for local and adopted projects", () => {
    expect(projectSlot("scrypted-local")).toBeNull();
    expect(projectSlot("scrypted")).toBeNull();
    expect(projectSlot(undefined)).toBeNull();
  });
});

describe("keepsRunning", () => {
  it("covers critical apps unless auto-restart is switched off", () => {
    expect(keepsRunning({ priority: "critical", autoRestartUnhealthy: null })).toBe(true);
    expect(keepsRunning({ priority: "critical", autoRestartUnhealthy: false })).toBe(false);
    expect(keepsRunning({ priority: "standard", autoRestartUnhealthy: true })).toBe(false);
  });

  it("resolves a compose child's null tier from its parent", () => {
    expect(resolvePriority({ priority: "critical" }, { priority: null })).toBe("critical");
    expect(resolvePriority({ priority: "standard" }, { priority: "critical" })).toBe("critical");
    expect(resolvePriority({ priority: null })).toBe("standard");
  });
});
