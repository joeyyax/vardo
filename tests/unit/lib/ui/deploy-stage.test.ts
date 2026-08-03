import { describe, it, expect } from "vitest";
import { currentStageLabel, DEPLOY_STAGE_KEYS, STAGE_LABELS } from "@/lib/ui/deploy-stage";

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
