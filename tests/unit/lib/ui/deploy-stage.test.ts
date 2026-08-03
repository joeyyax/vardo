import { describe, it, expect } from "vitest";
import {
  currentStageLabel,
  stageProgress,
  DEPLOY_STAGE_KEYS,
  ROLLBACK_STAGE_KEYS,
  STAGE_LABELS,
} from "@/lib/ui/deploy-stage";

describe("currentStageLabel", () => {
  it("names the running phase", () => {
    expect(currentStageLabel({ clone: "success", compose: "success", build: "running" })).toBe(
      "Build",
    );
  });

  it("prefers the earliest running phase when a later one has not started", () => {
    expect(currentStageLabel({ deploy: "running", healthcheck: "running" })).toBe("Deploy");
  });

  it("reads rollback phases when the run reports them", () => {
    expect(currentStageLabel({ stop: "success", restore: "running" })).toBe("Restore");
  });

  it("returns null before the first stage event and after the last", () => {
    expect(currentStageLabel({})).toBeNull();
    expect(currentStageLabel(undefined)).toBeNull();
    expect(currentStageLabel({ clone: "success", cleanup: "success" })).toBeNull();
  });

  it("labels every deploy phase", () => {
    for (const key of DEPLOY_STAGE_KEYS) {
      expect(STAGE_LABELS[key]).toBeTruthy();
    }
  });
});

describe("stageProgress", () => {
  it("counts the phase in flight", () => {
    expect(stageProgress({ clone: "skipped", compose: "success", build: "running" }, DEPLOY_STAGE_KEYS))
      .toEqual({ position: 3, total: 7 });
  });

  it("stops on the phase that failed", () => {
    expect(stageProgress({ clone: "success", compose: "failed" }, DEPLOY_STAGE_KEYS).position).toBe(2);
  });

  it("counts what resolved once no phase is in flight", () => {
    expect(stageProgress({ clone: "success", compose: "success" }, DEPLOY_STAGE_KEYS).position).toBe(2);
    expect(stageProgress({}, DEPLOY_STAGE_KEYS).position).toBe(0);
    expect(stageProgress(undefined, DEPLOY_STAGE_KEYS).position).toBe(0);
  });

  it("counts against the rollback list when the run reports rollback phases", () => {
    expect(stageProgress({ stop: "success", restore: "running" }, ROLLBACK_STAGE_KEYS))
      .toEqual({ position: 2, total: 4 });
  });
});
