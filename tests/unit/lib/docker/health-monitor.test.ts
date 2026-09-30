import { describe, it, expect, afterEach } from "vitest";
import {
  decideRestart,
  decideRecovery,
  effectiveAutoRestart,
  isCrashLooping,
  getCrashLoopThreshold,
  CONFIRM_STREAK,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
  RECOVERY_WINDOW_MS,
  RESTART_EXIT_GRACE_MS,
  FAILED_RESTART_WINDOW_MS,
  nextPendingRecovery,
  markRestartFailed,
  type PendingRecoveryState,
} from "@/lib/docker/health-monitor";

const NOW = 1_000_000_000;

describe("decideRestart", () => {
  it("waits until the unhealthy streak is confirmed", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK - 1, recentRestarts: [], now: NOW })).toBe("wait");
  });

  it("restarts once the streak is confirmed and there is no recent restart", () => {
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [], now: NOW })).toBe("restart");
  });

  it("backs off when a restart happened within the backoff window", () => {
    const recent = NOW - (RESTART_BACKOFF_MS - 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "backoff",
    );
  });

  it("restarts again once the backoff window has elapsed", () => {
    const recent = NOW - (RESTART_BACKOFF_MS + 1);
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: [recent], now: NOW })).toBe(
      "restart",
    );
  });

  it("gives up after the max restarts in the window", () => {
    // Spread the timestamps so none is inside the backoff window — the cap, not
    // backoff, must be what stops us.
    const restarts = Array.from(
      { length: MAX_RESTARTS_PER_WINDOW },
      (_, i) => NOW - RESTART_WINDOW_MS + i * (RESTART_BACKOFF_MS + 1),
    );
    expect(decideRestart({ streak: CONFIRM_STREAK, recentRestarts: restarts, now: NOW })).toBe(
      "giveup",
    );
  });
});

describe("effectiveAutoRestart", () => {
  it("defaults ON for critical apps when the field is unset", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "critical" })).toBe(true);
  });

  it("defaults OFF for non-critical apps when the field is unset", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "standard" })).toBe(false);
    expect(effectiveAutoRestart({ autoRestartUnhealthy: null, priority: "disposable" })).toBe(false);
  });

  it("explicit setting overrides the priority default", () => {
    expect(effectiveAutoRestart({ autoRestartUnhealthy: false, priority: "critical" })).toBe(false);
    expect(effectiveAutoRestart({ autoRestartUnhealthy: true, priority: "standard" })).toBe(true);
  });
});

describe("isCrashLooping", () => {
  it("fires once restarts pass the threshold without ever reaching healthy", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 5, everHealthy: false, threshold: 5 })).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 4, everHealthy: false, threshold: 5 })).toBe(false);
  });

  it("never fires for a container that has been healthy", () => {
    expect(isCrashLooping({ restartsSinceBaseline: 50, everHealthy: true, threshold: 5 })).toBe(false);
  });
});

describe("getCrashLoopThreshold", () => {
  const original = process.env.VARDO_CRASH_LOOP_RESTARTS;
  afterEach(() => {
    if (original === undefined) delete process.env.VARDO_CRASH_LOOP_RESTARTS;
    else process.env.VARDO_CRASH_LOOP_RESTARTS = original;
  });

  it("defaults to 5", () => {
    delete process.env.VARDO_CRASH_LOOP_RESTARTS;
    expect(getCrashLoopThreshold()).toBe(5);
  });

  it("reads the env override", () => {
    process.env.VARDO_CRASH_LOOP_RESTARTS = "12";
    expect(getCrashLoopThreshold()).toBe(12);
  });

  it("floors at 2 so a single restart can never trip it", () => {
    process.env.VARDO_CRASH_LOOP_RESTARTS = "1";
    expect(getCrashLoopThreshold()).toBe(2);
  });
});

describe("decideRecovery", () => {
  const base = { running: false, status: "exited", finishedAt: null, attemptAt: NOW, startTried: false, now: NOW + 30_000 };

  it("starts a container the restart left stopped", () => {
    // 2026-09-29: restart's kill timed out at +14s, the shim died at +25s, and
    // Docker's restart policy stood down.
    expect(decideRecovery({ ...base, finishedAt: NOW + 25_000 })).toBe("start");
  });

  it("leaves alone a container stopped well after the restart", () => {
    expect(decideRecovery({ ...base, finishedAt: NOW + RESTART_EXIT_GRACE_MS + 1, now: NOW + RECOVERY_WINDOW_MS - 1 })).toBe("done");
  });

  it("leaves alone an exit from before the restart", () => {
    expect(decideRecovery({ ...base, finishedAt: NOW - 1 })).toBe("done");
  });

  it("keeps watching a running container inside the window", () => {
    expect(decideRecovery({ ...base, running: true, status: "running" })).toBe("watch");
  });

  it("stops watching a running container once the window passes", () => {
    expect(decideRecovery({ ...base, running: true, status: "running", now: NOW + RECOVERY_WINDOW_MS })).toBe("done");
  });

  it("is done once the start it tried is running", () => {
    expect(decideRecovery({ ...base, running: true, status: "running", startTried: true })).toBe("done");
  });

  it("escalates when the container stops again after its start", () => {
    expect(decideRecovery({ ...base, finishedAt: NOW + 25_000, startTried: true })).toBe("escalate");
  });

  it("escalates a container stuck mid-transition past the window", () => {
    expect(decideRecovery({ ...base, status: "removing" })).toBe("watch");
    expect(decideRecovery({ ...base, status: "removing", now: NOW + RECOVERY_WINDOW_MS })).toBe("escalate");
  });
});

describe("decideRecovery after a failed restart", () => {
  const T = NOW;
  const MIN = 60_000;
  type P = PendingRecoveryState & { containerName: string };
  const failed = (attemptAt: number, now: number, extra: Partial<Parameters<typeof decideRecovery>[0]> = {}) =>
    decideRecovery({
      running: true,
      status: "running",
      finishedAt: null,
      attemptAt,
      restartFailed: true,
      firstFailedAt: T,
      healthy: false,
      startTried: false,
      now,
      ...extra,
    });
  const tick = (p: P, now: number, state: { running: boolean; status: string; finishedAt: number | null }) =>
    decideRecovery({ ...state, healthy: false, ...p, now });
  const attempt = (prev: P | undefined, at: number) =>
    markRestartFailed(nextPendingRecovery<P>(prev, { containerName: "scrypted" }, at), at);

  it("starts the container in the Scrypted NFS-wedge timeline", () => {
    // Restart calls failed at T and T+5m ("did not receive an exit event"); the
    // container read running until NFS recovered and exited 137 at T+9.5m.
    const running = { running: true, status: "running", finishedAt: null };
    let p = attempt(undefined, T);
    for (let t = T + 30_000; t <= T + 5 * MIN; t += 30_000) expect(tick(p, t, running)).toBe("watch");

    p = attempt(p, T + 5 * MIN);
    for (let t = T + 5.5 * MIN; t < T + 9.5 * MIN; t += 30_000) expect(tick(p, t, running)).toBe("watch");

    expect(tick(p, T + 10 * MIN, { running: false, status: "exited", finishedAt: T + 9.5 * MIN })).toBe("start");
  });

  it("keeps the first failure when a later attempt overwrites the entry", () => {
    const first = attempt(undefined, T);
    const second = nextPendingRecovery<P>(first, { containerName: "scrypted" }, T + 5 * MIN);
    expect(second).toMatchObject({ attemptAt: T + 5 * MIN, restartFailed: true, firstFailedAt: T, startTried: false });
  });

  it("keeps watching a wedged container past the ordinary window", () => {
    expect(failed(T, T + RECOVERY_WINDOW_MS)).toBe("watch");
    expect(failed(T, T + 90 * MIN)).toBe("watch");
  });

  it("escalates a container still wedged when the window closes", () => {
    expect(failed(T, T + FAILED_RESTART_WINDOW_MS)).toBe("escalate");
  });

  it("stops watching once the container reads healthy again", () => {
    expect(failed(T, T + 10 * MIN, { healthy: true })).toBe("done");
  });

  it("starts on an exit long after the attempt", () => {
    expect(failed(T, T + 91 * MIN, { running: false, status: "exited", finishedAt: T + 90 * MIN })).toBe("start");
  });

  it("leaves an exit from before the first failed attempt", () => {
    expect(failed(T + 5 * MIN, T + 6 * MIN, { running: false, status: "exited", finishedAt: T - 1 })).toBe("done");
  });

  it("escalates when the start it tried did not bring the container back", () => {
    expect(
      failed(T, T + 11 * MIN, { running: false, status: "exited", finishedAt: T + 10.5 * MIN, startTried: true }),
    ).toBe("escalate");
  });
});
