import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isRefreshEvent,
  createRefreshScheduler,
  appStatusFromEvent,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
} from "@/lib/bus/refresh";
import type { BusEvent } from "@/lib/bus/events";

describe("isRefreshEvent", () => {
  it("refreshes for deploy, app and backup events", () => {
    expect(isRefreshEvent("deploy.status")).toBe(true);
    expect(isRefreshEvent("deploy.success")).toBe(true);
    expect(isRefreshEvent("app.state-changed")).toBe(true);
    expect(isRefreshEvent("app.auto-restarted")).toBe(true);
    expect(isRefreshEvent("backup.failed")).toBe(true);
  });

  it("ignores events that change nothing a page renders", () => {
    expect(isRefreshEvent("digest.weekly")).toBe(false);
    expect(isRefreshEvent("org.invitation-sent")).toBe(false);
    expect(isRefreshEvent("system.cert-expiring")).toBe(false);
  });
});

describe("createRefreshScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst of events into a single refresh", () => {
    const run = vi.fn();
    const scheduler = createRefreshScheduler(run);

    for (let i = 0; i < 20; i++) {
      scheduler.schedule();
      vi.advanceTimersByTime(50);
    }
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires within the max wait even while events keep arriving", () => {
    const run = vi.fn();
    const scheduler = createRefreshScheduler(run);

    for (let i = 0; i < 100; i++) {
      scheduler.schedule();
      vi.advanceTimersByTime(100);
      if (run.mock.calls.length > 0) break;
    }

    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    expect(REFRESH_MAX_WAIT_MS).toBeGreaterThan(REFRESH_DEBOUNCE_MS);
  });

  it("refreshes again for events after a completed refresh", () => {
    const run = vi.fn();
    const scheduler = createRefreshScheduler(run);

    scheduler.schedule();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    scheduler.schedule();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending refresh", () => {
    const run = vi.fn();
    const scheduler = createRefreshScheduler(run);

    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS * 2);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("appStatusFromEvent", () => {
  function statusEvent(
    status: "running" | "active" | "error" | "cancelled" | "superseded",
  ): BusEvent {
    return {
      type: "deploy.status",
      title: "t",
      message: "m",
      appId: "a1",
      deploymentId: "d1",
      status,
      success: false,
    };
  }

  it("returns null while a deploy is still running", () => {
    expect(appStatusFromEvent(statusEvent("running"))).toBeNull();
  });

  it("maps terminal deploy statuses to an app status", () => {
    expect(appStatusFromEvent(statusEvent("active"))).toBe("active");
    expect(appStatusFromEvent(statusEvent("error"))).toBe("error");
    expect(appStatusFromEvent(statusEvent("cancelled"))).toBe("stopped");
    expect(appStatusFromEvent(statusEvent("superseded"))).toBe("stopped");
  });

  it("maps deploy outcome events", () => {
    expect(
      appStatusFromEvent({
        type: "deploy.success",
        title: "t",
        message: "m",
        projectName: "p",
        appId: "a1",
        deploymentId: "d1",
        duration: "1s",
      }),
    ).toBe("active");
    expect(
      appStatusFromEvent({
        type: "deploy.failed",
        title: "t",
        message: "m",
        projectName: "p",
        appId: "a1",
        deploymentId: "d1",
      }),
    ).toBe("error");
  });

  it("returns null for events that say nothing about app status", () => {
    expect(
      appStatusFromEvent({
        type: "backup.success",
        title: "t",
        message: "m",
        jobId: "j",
        jobName: "n",
        totalCount: 1,
        totalSize: 1,
      }),
    ).toBeNull();
  });
});
