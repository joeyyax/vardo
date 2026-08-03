import { describe, it, expect } from "vitest";
import { crashSummary, extractDeployError } from "@/lib/ui/deploy-error";

describe("extractDeployError", () => {
  it("returns the last failing line", () => {
    const log = [
      "[deploy] ERROR first problem",
      "[deploy] building",
      "[deploy] ERROR second problem",
      "[deploy] done",
    ].join("\n");
    expect(extractDeployError(log)).toBe("ERROR second problem");
  });

  it("strips the leading timestamp prefix", () => {
    expect(extractDeployError("[2026-08-01T00:00:00Z] FATAL out of memory")).toBe(
      "FATAL out of memory",
    );
  });

  it("redacts git access tokens", () => {
    expect(extractDeployError("[deploy] failed https://x-access-token:ghs_abc123@github.com/a/b")).toBe(
      "failed https://x-access-token:***@github.com/a/b",
    );
  });

  it("redacts a bare installation token", () => {
    expect(extractDeployError("[deploy] ERROR token ghs_SeCr3tValue rejected")).toBe(
      "ERROR token *** rejected",
    );
  });

  it("returns null when nothing in the log names a failure", () => {
    expect(extractDeployError("[deploy] all good\n[deploy] finished")).toBeNull();
  });

  it("returns null for an absent log", () => {
    expect(extractDeployError(null)).toBeNull();
    expect(extractDeployError(undefined)).toBeNull();
    expect(extractDeployError("")).toBeNull();
  });
});

describe("crashSummary", () => {
  const service = (name: string, status: string) => ({
    id: name,
    name,
    displayName: name,
    status,
  });

  it("names one crashed service", () => {
    const summary = crashSummary([service("bot", "error"), service("web", "active")]);
    expect(summary?.message).toBe("bot crashed");
    expect(summary?.crashed).toHaveLength(1);
  });

  it("joins two crashed services", () => {
    const summary = crashSummary([service("bot", "error"), service("dashboard", "error")]);
    expect(summary?.message).toBe("bot and dashboard crashed");
  });

  it("counts the overflow past two", () => {
    const summary = crashSummary([
      service("a", "error"),
      service("b", "error"),
      service("c", "error"),
      service("d", "error"),
    ]);
    expect(summary?.message).toBe("a, b and 2 more crashed");
  });

  it("adds services that are down but not crashed", () => {
    // The live `agents` stack: two services crashed, three stopped alongside.
    const summary = crashSummary([
      service("agents-bot", "error"),
      service("agents-dashboard", "error"),
      service("agents-postgres", "stopped"),
      service("agents-redis", "stopped"),
      service("agents-worker", "stopped"),
    ]);
    expect(summary?.message).toBe("agents-bot and agents-dashboard crashed, 3 more down");
    expect(summary?.down).toBe(3);
  });

  it("reports services that are only down", () => {
    expect(crashSummary([service("a", "stopped")])?.message).toBe("1 service down");
    expect(crashSummary([service("a", "missing"), service("b", "stopped")])?.message).toBe(
      "2 services down",
    );
  });

  it("returns null when nothing is wrong", () => {
    expect(crashSummary([service("a", "active")])).toBeNull();
    expect(crashSummary([])).toBeNull();
  });
});
