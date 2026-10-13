import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { deliveryClass, emailsEvent, QUICK_RESTART_SECONDS } from "@/lib/notifications/delivery-policy";

const off = { categories: {} };

describe("delivery policy", () => {
  it("sends failures now and leaves successes to the digest", () => {
    expect(deliveryClass("deploy.failed")).toBe("immediate");
    expect(deliveryClass("cron.failed")).toBe("immediate");
    expect(deliveryClass("deploy.success")).toBe("digest");
    expect(deliveryClass("backup.run-started")).toBe("digest");
  });

  it("batches scans and backup runs", () => {
    expect(deliveryClass("security.scan-findings")).toBe("batch");
    expect(deliveryClass("backup.summary")).toBe("batch");
  });

  it("emails a deploy started by hand, or every deploy once the org opts in", () => {
    const success = { type: "deploy.success", title: "", message: "", projectName: "api", appId: "a", deploymentId: "d", duration: "1s" } as BusEvent;
    expect(emailsEvent({ ...success, trigger: "manual" } as BusEvent, off)).toBe(true);
    expect(emailsEvent({ ...success, trigger: "webhook" } as BusEvent, off)).toBe(false);
    expect(emailsEvent({ ...success, trigger: "webhook" } as BusEvent, { categories: { deploySuccess: true } })).toBe(true);
  });

  it("emails one notice per Vardo restart: the outcome, never the start", () => {
    const ev = (e: Record<string, unknown>) => emailsEvent(e as BusEvent, off);
    const scope = { title: "", message: "", label: "the shared services", source: "maintenance" };
    expect(ev({ type: "system.shutdown", title: "", message: "", reason: "", version: "", uptimeSeconds: 1 })).toBe(false);
    expect(ev({ type: "system.restarting", ...scope, target: "services" })).toBe(false);
    expect(ev({ type: "system.restarted", ...scope, target: "services" })).toBe(false);
    expect(ev({ type: "system.restart-failed", ...scope, target: "services", error: "x" })).toBe(true);
    expect(ev({ type: "system.restarted", ...scope, label: "Vardo", target: "console" })).toBe(true);
  });

  it("folds a quick unclean restart into back up and keeps stopped unexpectedly for a long one", () => {
    const ev = (e: Record<string, unknown>) => emailsEvent(e as BusEvent, off);
    const base = { title: "", message: "", version: "", hostRebooted: true };
    const quick = QUICK_RESTART_SECONDS - 1;
    expect(ev({ type: "system.started", ...base, downSeconds: quick, unclean: true })).toBe(true);
    expect(ev({ type: "system.recovered-unclean", ...base, downSeconds: quick })).toBe(false);
    expect(ev({ type: "system.started", ...base, downSeconds: QUICK_RESTART_SECONDS, unclean: true })).toBe(false);
    expect(ev({ type: "system.recovered-unclean", ...base, downSeconds: QUICK_RESTART_SECONDS })).toBe(true);
    expect(ev({ type: "system.recovered-unclean", ...base })).toBe(true);
    expect(ev({ type: "system.started", ...base, downSeconds: 7_200 })).toBe(true);
  });

  it("emails one update result per rollout, not per step or instance", () => {
    const ev = (e: Record<string, unknown>) => emailsEvent(e as BusEvent, off);
    const update = { title: "", message: "", fromVersion: "a", toVersion: "b" };
    const rollout = { title: "", message: "", rolloutId: "r", targetSha: "b", targetLabel: "b", members: [] };
    expect(ev({ type: "system.update-started", ...update })).toBe(false);
    expect(ev({ type: "system.updated", ...update })).toBe(true);
    expect(ev({ type: "system.updated", ...update, rolloutId: "r" })).toBe(false);
    expect(ev({ type: "system.update-failed", ...update, step: "x", rolloutId: "r" })).toBe(false);
    expect(ev({ type: "system.rollout-started", ...rollout })).toBe(false);
    expect(ev({ type: "system.rollout-busy", ...rollout })).toBe(false);
    expect(ev({ type: "system.rollout-paused", ...rollout })).toBe(true);
    expect(ev({ type: "system.rollout-finished", ...rollout })).toBe(true);
  });

  it("emails a restart only when it didn't recover", () => {
    const restart = { type: "app.auto-restarted", title: "", message: "", appId: "a", appName: "api", containerName: "c", containerId: "c", reason: "unhealthy" };
    expect(emailsEvent({ ...restart, success: true, gaveUp: false } as BusEvent, off)).toBe(false);
    expect(emailsEvent({ ...restart, success: false, gaveUp: false } as BusEvent, off)).toBe(true);
    expect(emailsEvent({ ...restart, success: true, gaveUp: true } as BusEvent, off)).toBe(true);
  });
});
