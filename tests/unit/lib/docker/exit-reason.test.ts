import { describe, it, expect } from "vitest";

import {
  exitCandidates,
  exitReasonFor,
  isOomKill,
  reasonSurvivesRestart,
  worstExitReason,
  type ExitReason,
  type TerminalState,
} from "@/lib/docker/exit-reason";
import { exitReasonsEqual } from "@/lib/docker/status-reconcile";
import { oomRows } from "@/lib/ui/attention";
import type { ContainerInfo } from "@/lib/docker/client";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function terminal(over: Partial<TerminalState> = {}): TerminalState {
  return {
    containerId: "c1",
    containerName: "app-production-green-app-1",
    oomKilled: false,
    exitCode: 0,
    memoryLimit: 0,
    finishedAt: "2026-08-03T11:00:00.000Z",
    ...over,
  };
}

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: "c1",
    name: "app-1",
    image: "img",
    state: "exited",
    status: "Exited (0) 3 minutes ago",
    ports: [],
    labels: {},
    ...over,
  };
}

// The three states verified on the live host, all reading "Exited (137)".
describe("exitReasonFor", () => {
  it("calls an OOM kill with no limit a host kill", () => {
    const reason = exitReasonFor(
      terminal({
        containerName: "openspeedtest-production-green-openspeedtest-1",
        oomKilled: true,
        exitCode: 137,
        memoryLimit: 0,
      }),
      NOW,
    );
    expect(reason).toMatchObject({ kind: "oom-host", exitCode: 137 });
  });

  it("calls an OOM kill under a limit a cgroup kill", () => {
    const reason = exitReasonFor(
      terminal({ oomKilled: true, exitCode: 137, memoryLimit: 1073741824 }),
      NOW,
    );
    expect(reason).toMatchObject({ kind: "oom-limit", exitCode: 137 });
  });

  it("reads an ordinary 137 as a signal, not an incident", () => {
    const reason = exitReasonFor(
      terminal({
        containerName: "agents-production-blue-bot-1",
        oomKilled: false,
        exitCode: 137,
        memoryLimit: 1073741824,
      }),
      NOW,
    );
    expect(reason).toMatchObject({ kind: "signal", signal: "SIGKILL", exitCode: 137 });
    expect(isOomKill(reason)).toBe(false);
  });

  it("reads the blue-green teardown SIGTERM as a signal", () => {
    expect(exitReasonFor(terminal({ exitCode: 143 }), NOW)).toMatchObject({
      kind: "signal",
      signal: "SIGTERM",
    });
  });

  it("returns nothing for a clean exit", () => {
    expect(exitReasonFor(terminal({ exitCode: 0 }), NOW)).toBeNull();
  });

  it("reads a non-signal non-zero exit as a failure", () => {
    expect(exitReasonFor(terminal({ exitCode: 1 }), NOW)).toMatchObject({
      kind: "failed",
      exitCode: 1,
    });
    expect(exitReasonFor(terminal({ exitCode: 1 }), NOW)?.signal).toBeUndefined();
  });

  it("falls back to now when Docker reports no finish time", () => {
    expect(exitReasonFor(terminal({ exitCode: 1, finishedAt: "0001-01-01T00:00:00Z" }), NOW)?.at)
      .toBe(NOW.toISOString());
    expect(exitReasonFor(terminal({ exitCode: 1, finishedAt: "" }), NOW)?.at).toBe(
      NOW.toISOString(),
    );
  });
});

describe("exitCandidates", () => {
  it("skips running containers and clean exits", () => {
    const candidates = exitCandidates([
      container({ id: "up", state: "running", status: "Up 3 days" }),
      container({ id: "clean", status: "Exited (0) 3 minutes ago" }),
      container({ id: "killed", status: "Exited (137) 10 hours ago" }),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["killed"]);
  });

  it("includes a restarting container, whose status string carries no exit code", () => {
    const candidates = exitCandidates([
      container({ id: "flapping", state: "restarting", status: "Restarting (137) 2 seconds ago" }),
      container({ id: "dead", state: "dead", status: "Dead" }),
    ]);
    expect(candidates.map((c) => c.id)).toEqual(["flapping", "dead"]);
  });
});

describe("worstExitReason", () => {
  const reason = (over: Partial<ExitReason>): ExitReason => ({
    kind: "signal",
    exitCode: 137,
    containerId: "c1",
    containerName: "c",
    at: "2026-08-03T10:00:00.000Z",
    ...over,
  });

  it("returns null with nothing to report", () => {
    expect(worstExitReason([])).toBeNull();
  });

  // A stopped compose app has old-slot SIGKILLs alongside the container that died.
  it("prefers an OOM kill over a more recent ordinary stop", () => {
    const worst = worstExitReason([
      reason({ at: "2026-08-03T11:59:00.000Z" }),
      reason({ kind: "oom-host", containerName: "oom", at: "2026-08-02T21:17:00.000Z" }),
    ]);
    expect(worst?.containerName).toBe("oom");
  });

  it("breaks a tie on recency", () => {
    const worst = worstExitReason([
      reason({ kind: "oom-limit", containerName: "old", at: "2026-08-01T00:00:00.000Z" }),
      reason({ kind: "oom-host", containerName: "new", at: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(worst?.containerName).toBe("new");
  });

  it("prefers a failure over a signal", () => {
    expect(worstExitReason([reason({}), reason({ kind: "failed", containerName: "f" })])?.kind).toBe(
      "failed",
    );
  });
});

describe("reasonSurvivesRestart", () => {
  const oom: ExitReason = {
    kind: "oom-limit",
    exitCode: 137,
    containerId: "c1",
    containerName: "c",
    at: "2026-08-03T11:55:00.000Z",
  };
  const upSince = (isoMinutesAgo: number) =>
    new Date(NOW.getTime() - isoMinutesAgo * 60_000);

  it("keeps the kill while the same container is cycling", () => {
    expect(reasonSurvivesRestart(oom, { id: "c1", startedAt: upSince(1) }, NOW)).toBe(oom);
  });

  it("drops it once that container has stayed up", () => {
    expect(reasonSurvivesRestart(oom, { id: "c1", startedAt: upSince(30) }, NOW)).toBeNull();
  });

  it("drops it when a redeploy replaced the container", () => {
    expect(reasonSurvivesRestart(oom, { id: "c2", startedAt: upSince(1) }, NOW)).toBeNull();
  });

  it("does not carry an ordinary stop across a restart", () => {
    const stop = { ...oom, kind: "signal" as const };
    expect(reasonSurvivesRestart(stop, { id: "c1", startedAt: upSince(1) }, NOW)).toBeNull();
  });

  it("drops it with nothing running", () => {
    expect(reasonSurvivesRestart(oom, null, NOW)).toBeNull();
    expect(reasonSurvivesRestart(oom, { id: "c1", startedAt: null }, NOW)).toBeNull();
  });
});

describe("exitReasonsEqual", () => {
  const base: ExitReason = {
    kind: "oom-host",
    exitCode: 137,
    containerId: "c1",
    containerName: "c",
    at: "2026-08-03T10:00:00.000Z",
  };

  it("ignores the timestamp so a settled app skips its write", () => {
    expect(exitReasonsEqual(base, { ...base, at: "2026-08-03T11:00:00.000Z" })).toBe(true);
  });

  it("separates a host kill from a cgroup kill", () => {
    expect(exitReasonsEqual(base, { ...base, kind: "oom-limit" })).toBe(false);
  });

  it("treats absence on both sides as equal", () => {
    expect(exitReasonsEqual(null, null)).toBe(true);
    expect(exitReasonsEqual(null, undefined)).toBe(true);
    expect(exitReasonsEqual(base, null)).toBe(false);
  });
});

describe("oomRows", () => {
  const now = NOW.getTime();
  const week = 7 * 24 * 3_600_000;
  const app = (id: string, exitReason: ExitReason | null) => ({
    id,
    name: id,
    displayName: id,
    exitReason,
  });
  const kill = (kind: ExitReason["kind"], at = "2026-08-03T11:00:00.000Z"): ExitReason => ({
    kind,
    exitCode: 137,
    containerId: "c1",
    containerName: `${kind}-1`,
    at,
  });

  it("splits a host kill from a cgroup kill", () => {
    const rows = oomRows([app("a", kill("oom-host")), app("b", kill("oom-limit"))], now, week);
    expect(rows.map((r) => r.key)).toEqual(["oom-host", "oom-limit"]);
    expect(rows.every((r) => r.tone === "error")).toBe(true);
  });

  it("reports nothing for a deliberate stop or a clean app", () => {
    expect(oomRows([app("a", kill("signal")), app("b", null)], now, week)).toEqual([]);
  });

  it("drops a kill older than the window", () => {
    expect(oomRows([app("a", kill("oom-host", "2026-07-01T00:00:00.000Z"))], now, week)).toEqual([]);
  });
});
