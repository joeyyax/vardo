import { describe, it, expect } from "vitest";

import { exitReasonSentence } from "@/components/app-exit-reason";
import type { ExitReason } from "@/lib/docker/exit-reason";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const AT = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();

const reason = (extra: Partial<ExitReason> = {}): ExitReason => ({
  kind: "signal",
  exitCode: 143,
  signal: "SIGTERM",
  containerId: "c1",
  containerName: "transmission",
  at: AT,
  ...extra,
});

describe("exitReasonSentence", () => {
  it("keeps the exit code from running into the timestamp", () => {
    expect(exitReasonSentence(reason(), NOW)).toBe(
      "transmission took SIGTERM and exited 143, 2d ago.",
    );
  });

  it("separates a bare exit code too", () => {
    expect(exitReasonSentence(reason({ kind: "failed" }), NOW)).toBe(
      "transmission exited with code 143, 2d ago.",
    );
  });

  it("never puts two numbers side by side", () => {
    for (const kind of ["signal", "failed", "oom-limit", "oom-host"] as const) {
      expect(exitReasonSentence(reason({ kind }), NOW)).not.toMatch(/\d\s+\d/);
    }
  });

  it("uses the compact stamp the rest of the page uses", () => {
    expect(exitReasonSentence(reason({ at: new Date(NOW.getTime() - 47 * 86_400_000).toISOString() }), NOW))
      .toMatch(/6w ago\.$/);
  });
});
