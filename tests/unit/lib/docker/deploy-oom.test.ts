// ---------------------------------------------------------------------------
// The openspeedtest deploy on 2026-08-02: the old slot finished at 21:17:19,
// inside a window that opened at 21:17:07 and closed at 21:18:06, with
// State.OOMKilled and no memory limit of its own. The deploy reported success.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { oomKillsInWindow } from "@/lib/docker/deploy-oom";
import type { TerminalState } from "@/lib/docker/exit-reason";

const SINCE = new Date("2026-08-02T21:17:07.000Z");
const NOW = new Date("2026-08-02T21:18:06.000Z");

function terminal(over: Partial<TerminalState> = {}): TerminalState {
  return {
    containerId: "c1",
    containerName: "openspeedtest-production-green-openspeedtest-1",
    oomKilled: true,
    exitCode: 137,
    memoryLimit: 0,
    finishedAt: "2026-08-02T21:17:19.118Z",
    ...over,
  };
}

describe("oomKillsInWindow", () => {
  it("reports a host kill on the slot being retired", () => {
    expect(oomKillsInWindow([terminal()], SINCE, NOW)).toMatchObject([
      { kind: "oom-host", exitCode: 137 },
    ]);
  });

  it("separates a kill under the container's own limit", () => {
    expect(oomKillsInWindow([terminal({ memoryLimit: 1024 ** 3 })], SINCE, NOW)).toMatchObject([
      { kind: "oom-limit" },
    ]);
  });

  it("ignores an ordinary stop that outran its grace period", () => {
    expect(oomKillsInWindow([terminal({ oomKilled: false })], SINCE, NOW)).toEqual([]);
  });

  it("ignores a clean exit", () => {
    expect(oomKillsInWindow([terminal({ oomKilled: false, exitCode: 0 })], SINCE, NOW)).toEqual([]);
  });

  it("ignores a kill that predates the window", () => {
    const before = terminal({ finishedAt: "2026-08-02T20:00:00.000Z" });
    expect(oomKillsInWindow([before], SINCE, NOW)).toEqual([]);
  });

  it("reports every killed container in a stack, not just the first", () => {
    const kills = oomKillsInWindow(
      [terminal({ containerId: "c1" }), terminal({ containerId: "c2" })],
      SINCE,
      NOW,
    );
    expect(kills).toHaveLength(2);
  });

  it("finds nothing when the old slot was never up", () => {
    expect(oomKillsInWindow([], SINCE, NOW)).toEqual([]);
  });
});
