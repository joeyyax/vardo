import { describe, it, expect } from "vitest";
import { isTerminalStageEvent } from "@/lib/docker/deploy-logger";

// ---------------------------------------------------------------------------
// isTerminalStageEvent — what closes the deploy SSE stream
//
// Every stage reports "success" of its own, so treating any success as terminal
// closed the stream on the first one. Only `done` ends a successful deploy.
// ---------------------------------------------------------------------------

describe("isTerminalStageEvent", () => {
  it("does not close on an intermediate stage succeeding", () => {
    for (const stage of ["clone", "compose", "build", "deploy", "healthcheck", "routing", "cleanup"]) {
      expect(isTerminalStageEvent(stage, "success")).toBe(false);
    }
  });

  it("does not close on a stage starting or being skipped", () => {
    expect(isTerminalStageEvent("build", "running")).toBe(false);
    expect(isTerminalStageEvent("clone", "skipped")).toBe(false);
    expect(isTerminalStageEvent("done", "running")).toBe(false);
  });

  it("closes on done", () => {
    expect(isTerminalStageEvent("done", "success")).toBe(true);
  });

  it("closes on a failure or cancel at any stage", () => {
    expect(isTerminalStageEvent("clone", "failed")).toBe(true);
    expect(isTerminalStageEvent("deploy", "failed")).toBe(true);
    expect(isTerminalStageEvent("build", "cancelled")).toBe(true);
  });

  it("does not close on a malformed event", () => {
    expect(isTerminalStageEvent(undefined, undefined)).toBe(false);
    expect(isTerminalStageEvent("done", undefined)).toBe(false);
  });
});
