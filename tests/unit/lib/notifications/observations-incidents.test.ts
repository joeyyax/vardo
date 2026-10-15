import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "@/lib/bus/events";
import type { IncidentRef } from "@/lib/incidents/types";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const m = vi.hoisted(() => ({
  emit: vi.fn(),
  claim: vi.fn(),
  clear: vi.fn(),
  clearSubjects: vi.fn(),
  settings: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(),
  severities: vi.fn(),
  lower: vi.fn(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit }));
vi.mock("@/lib/notifications/resolved-hold", async (orig) => (await import("@/tests/helpers/mocks")).resolvedHoldModule(orig));
vi.mock("@/lib/notifications/throttle", () => ({ claimNotifications: m.claim, clearNotifications: m.clear, clearSubjects: m.clearSubjects }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: m.settings }));
vi.mock("@/lib/incidents/store", () => ({
  openIncident: m.open,
  resolveIncidents: m.resolve,
  openSeverities: m.severities,
  lowerSeverity: m.lower,
  safely: async <T,>(_: string, fn: () => Promise<T>, fallback: T) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));

const { notifyObservations, fireAlert, settleAlerts, resolveAlert } = await import("@/lib/notifications/observations");
import type { Observation } from "@/lib/notifications/observations";

const now = new Date("2026-10-10T12:00:00Z");

function ref(overrides: Partial<IncidentRef> = {}): IncidentRef {
  return {
    id: "inc_1",
    key: "host:local:host.memory",
    kind: "host.memory",
    state: "open",
    transition: "opened",
    severity: "warning",
    peakSeverity: "warning",
    subject: { type: "host", id: "local" },
    title: "Memory 92% used",
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    resolvedAt: null,
    updates: 0,
    url: "https://vardo.example.com/metrics",
    ...overrides,
  };
}

function obs(type: Observation["type"], about: string, severity: "warning" | "critical" = "warning", fires = true): Observation {
  const item: AlertItem = { type, about, severity, title: `${type} ${about}`, detail: "Raw detail" };
  return { type, about, severity, fires, item };
}

const cleared = (type: string, about: string) => ({
  about,
  severity: "warning",
  sentAt: new Date(now.getTime() - 3_600_000),
  detail: { type, about, severity: "warning", title: `${type} ${about}`, detail: "Raw detail" },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.settings.mockResolvedValue({ categories: { backups: true, host: true, apps: true, anomalies: true, cron: true } });
  m.claim.mockImplementation(async (_o: string, _t: string, reqs: { about: string }[]) => reqs.map((r) => ({ about: r.about, previous: null })));
  m.clear.mockResolvedValue([]);
  m.clearSubjects.mockResolvedValue([]);
  m.open.mockImplementation(async (_o: string, r: { kind: string }) => ref({ kind: r.kind }));
  m.resolve.mockResolvedValue(new Map());
  m.severities.mockResolvedValue(new Map());
});

describe("incidents through the alert pass", () => {
  it("opens an incident for each alert that goes out and carries it on the notice", async () => {
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(m.open).toHaveBeenCalledWith("org1", expect.objectContaining({ kind: "host.memory", about: "host", severity: "warning" }), now);
    const [, event] = m.emit.mock.calls[0];
    expect(event.incident).toMatchObject({ id: "inc_1", transition: "opened" });
    expect(event.alerts[0].incident.id).toBe("inc_1");
  });

  it("opens nothing while the throttle holds the alert back", async () => {
    m.claim.mockResolvedValue([]);
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(m.open).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("records a drop in severity without a notice", async () => {
    m.claim.mockResolvedValue([]);
    m.severities.mockResolvedValue(new Map([["host:local:host.memory", "critical"]]));
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host", "warning")], now);
    expect(m.lower).toHaveBeenCalledWith("org1", "host:local:host.memory", "warning", now);
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("resolves the incident when the condition clears", async () => {
    m.clear.mockResolvedValue([cleared("host.memory", "host")]);
    m.resolve.mockResolvedValue(new Map([["host", ref({ state: "resolved", transition: "resolved", durationMs: 3_600_000 })]]));
    await notifyObservations("org1", ["host.memory"], [], now);
    expect(m.resolve).toHaveBeenCalledWith("org1", "host.memory", ["host"], now);
    const [, event] = m.emit.mock.calls[0];
    expect(event).toMatchObject({ type: "alert.resolved", incident: { transition: "resolved", durationMs: 3_600_000 } });
    expect(event.quiet).toBeUndefined();
  });

  it("closes an incident of a type without a resolved email for webhooks only", async () => {
    m.clear.mockImplementation(async (_o: string, type: string) => (type === "app.oom" ? [cleared("app.oom", "a1")] : []));
    m.resolve.mockImplementation(async (_o: string, type: string) =>
      type === "app.oom" ? new Map([["a1", ref({ kind: "app.oom", state: "resolved", transition: "resolved" })]]) : new Map(),
    );
    await notifyObservations("org1", ["app.oom"], [], now);
    const [, event] = m.emit.mock.calls[0];
    expect(event).toMatchObject({ type: "alert.resolved", quiet: true });
    expect(event.alerts[0]).toMatchObject({ type: "app.oom", detail: "", incident: { transition: "resolved" } });
  });

  it("closes quietly when the org muted the category", async () => {
    m.settings.mockResolvedValue({ categories: { host: false } });
    m.clear.mockResolvedValue([cleared("host.memory", "host")]);
    m.resolve.mockResolvedValue(new Map([["host", ref({ state: "resolved", transition: "resolved" })]]));
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(m.open).not.toHaveBeenCalled();
    expect(m.emit.mock.calls[0][1]).toMatchObject({ type: "alert.resolved", quiet: true });
  });

  it("still sends the alert when the incident store fails", async () => {
    m.open.mockRejectedValue(new Error("db down"));
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    const [, event] = m.emit.mock.calls[0];
    expect(event.type).toBe("alert.fired");
    expect(event.incident).toBeUndefined();
  });
});

describe("single alerts", () => {
  it("fireAlert carries the incident", async () => {
    const item: AlertItem = { type: "backup.failure", about: "backup:a1/data", severity: "critical", title: "Backup failed", detail: "tar: error" };
    expect(await fireAlert("org1", "backup.failure", item, now)).toBe(true);
    expect(m.emit.mock.calls[0][1].incident).toMatchObject({ id: "inc_1" });
  });

  it("settleAlerts closes the incident for webhooks without an email", async () => {
    m.clearSubjects.mockResolvedValue([cleared("backup.failure", "backup:a1/data")]);
    m.resolve.mockResolvedValue(new Map([["backup:a1/data", ref({ kind: "backup.failure", state: "resolved", transition: "resolved" })]]));
    await settleAlerts("org1", "backup.failure", ["backup:a1/data"], now);
    expect(m.emit.mock.calls[0][1]).toMatchObject({ type: "alert.resolved", quiet: true, incident: { kind: "backup.failure" } });
  });

  it("resolveAlert sends the recovery with the incident", async () => {
    m.clear.mockResolvedValue([cleared("cron.failure", "job1")]);
    m.resolve.mockResolvedValue(new Map([["job1", ref({ kind: "cron.failure", state: "resolved", transition: "resolved" })]]));
    expect(await resolveAlert("org1", "cron.failure", "job1", now)).toBe(true);
    const [, event] = m.emit.mock.calls[0];
    expect(event.quiet).toBeUndefined();
    expect(event.incident.kind).toBe("cron.failure");
  });
});
