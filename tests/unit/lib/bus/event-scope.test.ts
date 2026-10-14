import { describe, it, expect, expectTypeOf } from "vitest";
import { EVENT_SCOPES, eventAppIds } from "@/lib/bus/event-scope";
import { ALL_EVENT_TYPES, type BusEvent, type BusEventType } from "@/lib/bus/events";
import { SILENT_EVENT_TYPES } from "@/lib/notifications/ui-only";

// Each type with a sample event and the app ids a project filter sees; null is org-level.
const host = { type: "host.memory", about: "host", severity: "critical", title: "Memory", detail: "d" };
const onApp = (appId: string) => ({ ...host, type: "app.memory", about: appId, appId });
const resolved = { firedAt: "t", resolvedAt: "t" };

const CASES: Record<BusEventType, [Record<string, unknown>, string[] | null]> = {
  "deploy.success": [{ appId: "a1" }, ["a1"]],
  "deploy.failed": [{ appId: "a1" }, ["a1"]],
  "deploy.incomplete": [{ appId: "a1" }, ["a1"]],
  "deploy.rollback": [{ appId: "a1" }, ["a1"]],
  "deploy.status": [{ appId: "a1" }, ["a1"]],
  "app.state-changed": [{ appId: "a1" }, ["a1"]],
  "app.auto-restarted": [{ appId: "a1" }, ["a1"]],
  "app.oom-killed": [{ appId: "a1" }, ["a1"]],
  "cron.failed": [{ appId: "a1" }, ["a1"]],
  "volume.drift": [{ appId: "a1" }, ["a1"]],
  "disk.write-alert": [{ appId: "a1" }, ["a1"]],
  "backup.progress": [{ appId: "a1" }, ["a1"]],
  "backup.run-started": [{ apps: [{ appId: "a1" }, { appId: null }, { appId: "a2" }] }, ["a1", "a2"]],
  "backup.summary": [{ rows: [{ appId: "a1" }, { appId: null }], run: { unfinishedAppIds: { job: "a2" } } }, ["a1", "a2"]],
  "security.scan-findings": [{ appId: "a1", apps: [{ appId: "a1" }, { appId: "a2" }] }, ["a1", "a2"]],
  "security.domain-claimed": [{ appIds: ["a1", "a1"] }, ["a1"]],
  "system.cert-expiring": [{ app: { id: "a1", name: "web" } }, ["a1"]],
  "digest.app-recap": [{ recaps: [{ appId: "a1" }] }, ["a1"]],
  "alert.fired": [{ alerts: [onApp("a1"), onApp("a2")] }, ["a1", "a2"]],
  "alert.resolved": [{ alerts: [{ ...onApp("a1"), ...resolved }] }, ["a1"]],
  "security.file-exposed": [{ appName: "web" }, null],
  "backup.success": [{ jobId: "j1" }, null],
  "backup.failed": [{ jobId: "j1" }, null],
  "digest.health": [{}, null],
  "org.invitation-sent": [{}, null],
  "org.invitation-accepted": [{}, null],
  "system.service-down": [{}, null],
  "system.restart-loop": [{}, null],
  "system.update-available": [{}, null],
  "system.integration-permissions": [{}, null],
  "system.shutdown": [{}, null],
  "system.started": [{}, null],
  "system.recovered-unclean": [{}, null],
  "system.update-started": [{}, null],
  "system.updated": [{}, null],
  "system.update-failed": [{}, null],
  "system.rollout-started": [{}, null],
  "system.rollout-busy": [{}, null],
  "system.rollout-paused": [{}, null],
  "system.rollout-finished": [{}, null],
  "system.restarting": [{}, null],
  "system.restarted": [{}, null],
  "system.restart-failed": [{}, null],
  "system.containers-missing": [{ containers: [{ name: "web-1", appId: "a1", state: "exited" }] }, null],
  "notification.test": [{}, null],
};

const sample = (type: BusEventType, fields: Record<string, unknown>) =>
  ({ type, title: "t", message: "m", ...fields }) as BusEvent;

describe("event scopes", () => {
  it("classifies every event type", () => {
    expectTypeOf<keyof typeof EVENT_SCOPES>().toEqualTypeOf<BusEventType>();
    const classified = Object.keys(EVENT_SCOPES).sort();
    expect(classified).toEqual(Object.keys(CASES).sort());
    for (const type of [...ALL_EVENT_TYPES, ...SILENT_EVENT_TYPES]) expect(classified).toContain(type);
  });

  it.each(Object.entries(CASES))("%s", (type, [fields, expected]) => {
    const ids = eventAppIds(sample(type as BusEventType, fields));
    expect(ids === null ? null : [...ids].sort()).toEqual(expected);
  });

  it("treats an alert batch with a host alert as org-level", () => {
    expect(eventAppIds(sample("alert.fired", { alerts: [onApp("a1"), host] }))).toBeNull();
    expect(eventAppIds(sample("alert.resolved", { alerts: [{ ...host, ...resolved }] }))).toBeNull();
  });

  it("treats an event without its app as org-level", () => {
    expect(eventAppIds(sample("cron.failed", {}))).toBeNull();
    expect(eventAppIds(sample("system.cert-expiring", { domain: "example.com" }))).toBeNull();
    expect(eventAppIds(sample("backup.summary", { rows: [{ appId: null }], run: {} }))).toBeNull();
  });

  it("treats an unknown type as org-level", () => {
    expect(eventAppIds({ type: "deploy.retired", appId: "a1" } as unknown as BusEvent)).toBeNull();
  });
});
