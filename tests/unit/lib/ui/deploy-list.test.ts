import { describe, it, expect } from "vitest";
import { deployCounts, deployMark, deployProblem, isDeployFilter, isRollback, matchesDeployFilter } from "@/lib/ui/deploy-list";

const NOW = new Date("2026-10-10T12:00:00Z").getTime();
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000);
const d = (over: Partial<Parameters<typeof deployMark>[0]> = {}) => ({
  status: "success",
  trigger: "manual",
  log: null,
  postDeployError: null,
  startedAt: ago(1),
  ...over,
});

describe("deploy filters", () => {
  it("accepts only known filters", () => {
    expect(isDeployFilter("failed")).toBe(true);
    expect(isDeployFilter("rollbacks")).toBe(true);
    expect(isDeployFilter("all")).toBe(false);
    expect(isDeployFilter(null)).toBe(false);
  });

  it("counts a rollback by status or by trigger", () => {
    expect(isRollback(d({ status: "rolled_back" }))).toBe(true);
    expect(isRollback(d({ trigger: "rollback" }))).toBe(true);
    expect(isRollback(d())).toBe(false);
  });

  it("counts only inside the window", () => {
    const list = [d({ status: "failed" }), d({ status: "failed", startedAt: ago(8) }), d({ status: "rolled_back", startedAt: ago(6) })];
    expect(deployCounts(list, NOW)).toEqual({ failed: 1, rollbacks: 1 });
    expect(matchesDeployFilter(list[1], "failed", NOW)).toBe(false);
  });
});

describe("deployMark", () => {
  it("marks the live release by the app's state", () => {
    expect(deployMark(d(), "live", "active").label).toBe("Live");
    expect(deployMark(d(), "live", "error").tone).toBe("issue");
    expect(deployMark(d(), "live", "stopped").tone).toBe("stopped");
  });

  it("keeps past releases quiet and problems loud", () => {
    expect(deployMark(d(), "history", "active").tone).toBe("neutral");
    expect(deployMark(d({ status: "failed" }), "history", "active").tone).toBe("issue");
    expect(deployMark(d({ status: "rolled_back" }), "history", "active").tone).toBe("warn");
    expect(deployMark(d(), "queued", "active").pending).toBe(true);
  });
});

describe("deployProblem", () => {
  it("names the failing line from the log", () => {
    const log = "[deploy] Pulling\n[deploy] ERROR: health check timed out";
    expect(deployProblem(d({ status: "failed", log }), "history", "active")).toEqual({
      text: "ERROR: health check timed out",
      tone: "error",
    });
  });

  it("is null for a clean deploy", () => {
    expect(deployProblem(d(), "history", "active")).toBeNull();
  });
});
