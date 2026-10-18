import { describe, it, expect } from "vitest";
import { describePlacement, placeDeploy } from "@/lib/pipeline/stops";

// Where a deploy sits on the Pipeline map, from its row.

const place = (status: string, stage: string | null = null, waitReason: string | null = null) => placeDeploy({ status, stage, waitReason });

describe("placeDeploy", () => {
  it("puts a queued deploy in the queue, waiting", () => {
    expect(place("queued")).toEqual({ stop: "queue", waiting: true, failed: false, gone: false });
  });

  it("counts clone and compose as the way from the queue to the build", () => {
    expect(place("running", "clone").stop).toBe("gate");
    expect(place("running", "compose").stop).toBe("gate");
    expect(place("running", null).stop).toBe("gate");
  });

  it("holds a deploy waiting for a builder at the gate", () => {
    expect(place("running", "build", "build-slot")).toMatchObject({ stop: "gate", waiting: true });
  });

  it("keeps a claimed deploy waiting on its app or a deploy slot in the queue", () => {
    expect(place("running", "queued", "deploy-slot")).toMatchObject({ stop: "queue", waiting: true });
    expect(place("running", null, "app")).toMatchObject({ stop: "queue", waiting: true });
  });

  it("maps each later stage to its stop", () => {
    expect(place("running", "build").stop).toBe("build");
    expect(place("running", "deploy").stop).toBe("swap");
    expect(place("running", "healthcheck").stop).toBe("health");
    expect(place("running", "routing").stop).toBe("routing");
    expect(place("running", "cleanup").stop).toBe("live");
    expect(place("success", "done").stop).toBe("live");
  });

  it("reads an auto-rollback's own run as rolling back, not preparing", () => {
    const p = placeDeploy({ status: "running", stage: null, waitReason: null, trigger: "rollback" });
    expect(p.stop).toBe("rolledBack");
    expect(describePlacement(p, { status: "running" })).toBe("Rolling back");
    expect(describePlacement(p, { status: "rolled_back" })).toBe("Rolled back");
  });

  it("sends a failure after the swap down the rolled-back branch", () => {
    expect(place("failed", "healthcheck")).toEqual({ stop: "rolledBack", waiting: false, failed: false, gone: false });
    expect(place("failed", "deploy").stop).toBe("rolledBack");
    expect(place("rolled_back", "done").stop).toBe("rolledBack");
  });

  it("leaves a failure before the swap at its stop, marked failed", () => {
    expect(place("failed", "build")).toEqual({ stop: "build", waiting: false, failed: true, gone: false });
    expect(place("failed", "clone")).toMatchObject({ stop: "gate", failed: true });
  });

  it("marks cancelled and superseded deploys gone", () => {
    expect(place("cancelled", "build").gone).toBe(true);
    expect(place("superseded", null).gone).toBe(true);
  });
});

describe("describePlacement", () => {
  it("names the wait, the builder and the failure", () => {
    expect(describePlacement(place("running", "build", "build-slot"), { waitReason: "build-slot" })).toBe("Waiting for a builder");
    expect(describePlacement(place("running", "build"), { stage: "build", builder: "Long House" })).toBe("Building on Long House");
    expect(describePlacement(place("running", "clone"), { stage: "clone" })).toBe("Preparing");
    expect(describePlacement(place("running", "deploy"), { stage: "deploy" })).toBe("Starting");
    expect(describePlacement(place("running", "routing"), { stage: "routing" })).toBe("Switching traffic");
    expect(describePlacement(place("failed", "build"), { stage: "build" })).toBe("Failed at build");
    expect(describePlacement(place("failed", "compose"), { stage: "compose" })).toBe("Failed at prepare");
    expect(describePlacement(place("failed", "healthcheck"), { stage: "healthcheck" })).toBe("Rolled back");
  });
});
