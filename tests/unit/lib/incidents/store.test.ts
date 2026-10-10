import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentRow } from "@/lib/db/schema";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/activity/record", () => ({ recordActivity: vi.fn() }));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://vardo.example.com");

import { dbMock } from "@/tests/helpers/db";
const { incidentKey, incidentRef, incidentSubject, FLAP_WINDOW_MS } = await import("@/lib/incidents/key");
const { openIncident, resolveIncidents, withinFlapWindow } = await import("@/lib/incidents/store");

const now = new Date("2026-10-10T12:00:00Z");

function row(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: "inc_abc",
    organizationId: "org1",
    key: "app:a1:app.restart-loop",
    kind: "app.restart-loop",
    subjectType: "app",
    subjectId: "a1",
    appId: "a1",
    title: "Shop keeps restarting",
    severity: "critical",
    peakSeverity: "critical",
    state: "open",
    openedAt: new Date(now.getTime() - 2 * 3_600_000),
    updatedAt: now,
    resolvedAt: null,
    updateCount: 0,
    reopenCount: 0,
    lastNotifiedState: "opened",
    lastNotifiedAt: now,
    channelMessages: {},
    ...overrides,
  };
}

const req = { kind: "app.restart-loop", about: "a1", severity: "critical" as const, title: "Shop keeps restarting", appId: "a1" };

beforeEach(() => dbMock.reset());

describe("incident keys", () => {
  it("are the same for the same subject and kind, and differ otherwise", () => {
    expect(incidentKey("app.restart-loop", "a1")).toBe("app:a1:app.restart-loop");
    expect(incidentKey("app.restart-loop", "a1")).toBe(incidentKey("app.restart-loop", "a1"));
    expect(incidentKey("app.restart-loop", "a2")).not.toBe(incidentKey("app.restart-loop", "a1"));
    expect(incidentKey("app.unhealthy", "a1")).not.toBe(incidentKey("app.restart-loop", "a1"));
  });

  it("name the subject by kind", () => {
    expect(incidentKey("host.cpu", "host")).toBe("host:local:host.cpu");
    expect(incidentSubject("backup.failure", "backup:a1/data")).toEqual({ type: "volume", id: "backup:a1/data" });
    expect(incidentSubject("cron.failure", "job1")).toEqual({ type: "cron-job", id: "job1" });
    expect(incidentSubject("deploy.failed", "a1/env1")).toEqual({ type: "app", id: "a1/env1" });
  });
});

describe("incidentRef", () => {
  it("carries the structured fields and a console link", () => {
    const ref = incidentRef(row({ state: "resolved", resolvedAt: now }), "resolved");
    expect(ref).toEqual({
      id: "inc_abc",
      key: "app:a1:app.restart-loop",
      kind: "app.restart-loop",
      state: "resolved",
      transition: "resolved",
      severity: "critical",
      peakSeverity: "critical",
      subject: { type: "app", id: "a1" },
      appId: "a1",
      title: "Shop keeps restarting",
      openedAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T12:00:00.000Z",
      resolvedAt: "2026-10-10T12:00:00.000Z",
      durationMs: 2 * 3_600_000,
      updates: 0,
      url: "https://vardo.example.com/apps/a1",
    });
  });
});

describe("openIncident", () => {
  it("opens a new incident with an opaque id", async () => {
    dbMock.query.incidents.findFirst.mockResolvedValue(undefined);
    dbMock.insertReturns([row({ id: "inc_new" })]);
    const ref = await openIncident("org1", req, now);
    expect(ref).toMatchObject({ id: "inc_new", transition: "opened", state: "open" });
    const values = dbMock.inserts[0].values as IncidentRow;
    expect(values.id).toMatch(/^inc_[0-9a-z]{20}$/);
    expect(values.key).toBe("app:a1:app.restart-loop");
  });

  it("updates the open incident instead of opening a second, as after a restart", async () => {
    dbMock.query.incidents.findFirst.mockResolvedValueOnce(row({ severity: "warning" }));
    dbMock.updateReturns([row({ updateCount: 1 })]);
    const ref = await openIncident("org1", req, now);
    expect(dbMock.inserts).toHaveLength(0);
    expect(ref).toMatchObject({ id: "inc_abc", transition: "updated", reason: "escalated", updates: 1 });
  });

  it("reuses an incident resolved inside the flap window", async () => {
    const resolved = row({ state: "resolved", resolvedAt: new Date(now.getTime() - 10 * 60_000) });
    dbMock.query.incidents.findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(resolved);
    dbMock.updateReturns([row({ updateCount: 1, reopenCount: 1 })]);
    const ref = await openIncident("org1", req, now);
    expect(dbMock.inserts).toHaveLength(0);
    expect(dbMock.updates[0].set).toMatchObject({ state: "open", resolvedAt: null });
    expect(ref).toMatchObject({ id: "inc_abc", state: "open", transition: "updated", reason: "reopened" });
  });

  it("opens a new incident once the flap window has passed", async () => {
    const resolved = row({ state: "resolved", resolvedAt: new Date(now.getTime() - FLAP_WINDOW_MS - 1) });
    dbMock.query.incidents.findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(resolved);
    dbMock.insertReturns([row({ id: "inc_second" })]);
    const ref = await openIncident("org1", req, now);
    expect(dbMock.updates).toHaveLength(0);
    expect(ref).toMatchObject({ id: "inc_second", transition: "opened" });
  });

  it("joins the incident another process opened first", async () => {
    dbMock.query.incidents.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row({ id: "inc_winner" }));
    dbMock.insertReturns([]);
    dbMock.updateReturns([row({ id: "inc_winner", updateCount: 1 })]);
    const ref = await openIncident("org1", req, now);
    expect(ref).toMatchObject({ id: "inc_winner", transition: "updated" });
  });
});

describe("withinFlapWindow", () => {
  it("holds for 30 minutes after resolution", () => {
    expect(withinFlapWindow({ resolvedAt: new Date(now.getTime() - FLAP_WINDOW_MS) }, now)).toBe(true);
    expect(withinFlapWindow({ resolvedAt: new Date(now.getTime() - FLAP_WINDOW_MS - 1) }, now)).toBe(false);
    expect(withinFlapWindow({ resolvedAt: null }, now)).toBe(false);
  });
});

describe("resolveIncidents", () => {
  it("resolves by subject and reports the duration", async () => {
    dbMock.updateReturns([row({ state: "resolved", resolvedAt: now })]);
    const refs = await resolveIncidents("org1", "app.restart-loop", ["a1"], now);
    expect(dbMock.updates[0].set).toMatchObject({ state: "resolved", resolvedAt: now, lastNotifiedState: "resolved" });
    expect(refs.get("a1")).toMatchObject({ transition: "resolved", state: "resolved", durationMs: 2 * 3_600_000 });
  });

  it("does nothing without subjects", async () => {
    expect((await resolveIncidents("org1", "app.restart-loop", [], now)).size).toBe(0);
    expect(dbMock.updates).toHaveLength(0);
  });
});
