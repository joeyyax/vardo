import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "@/lib/bus/events";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  claim: vi.fn(),
  clear: vi.fn(),
  settings: vi.fn(),
  hold: vi.fn(),
  sendHeld: vi.fn(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/throttle", () => ({ claimNotifications: mocks.claim, clearNotifications: mocks.clear }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: mocks.settings }));
vi.mock("@/lib/notifications/resolved-hold", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/resolved-hold")>()),
  holdResolved: mocks.hold,
  sendHeldResolved: mocks.sendHeld,
}));

const { notifyObservations } = await import("@/lib/notifications/observations");
import type { Observation } from "@/lib/notifications/observations";

const now = new Date("2026-10-09T12:00:00Z");

function obs(type: Observation["type"], about: string, severity: "warning" | "critical" = "warning"): Observation {
  const item: AlertItem = { type, about, severity, title: `${type} ${about}`, detail: "" };
  return { type, about, severity, fires: true, item };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ categories: { backups: true, host: true, apps: true }, batchWindowMinutes: 30 });
  mocks.claim.mockImplementation(async (_org: string, _type: string, requests: { about: string }[]) =>
    requests.map((r) => ({ about: r.about, previous: null })),
  );
  mocks.clear.mockResolvedValue([]);
  mocks.hold.mockResolvedValue(undefined);
  mocks.sendHeld.mockResolvedValue(false);
});

describe("notifyObservations", () => {
  it("rolls alerts that fire together into one email, worst first", async () => {
    await notifyObservations(
      "org1",
      ["host.memory", "app.oom"],
      [obs("host.memory", "host"), obs("app.oom", "a1", "critical"), obs("app.oom", "a2", "critical")],
      now,
    );
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const [, event] = mocks.emit.mock.calls[0];
    expect(event.type).toBe("alert.fired");
    expect(event.alerts.map((a: AlertItem) => a.type)).toEqual(["app.oom", "app.oom", "host.memory"]);
  });

  it("sends nothing for an alert the throttle already sent", async () => {
    mocks.claim.mockResolvedValue([]);
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("sends a resolved notice when a resolving type clears, never for OOM kills", async () => {
    mocks.clear.mockImplementation(async (_org: string, type: string) =>
      [{ about: "x", severity: "warning", sentAt: new Date(now.getTime() - 60_000), detail: { type, about: "x", severity: "warning", title: type, detail: "" } }],
    );
    await notifyObservations("org1", ["host.memory", "app.oom"], [], now);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    const [, event] = mocks.emit.mock.calls[0];
    expect(event.type).toBe("alert.resolved");
    expect(event.alerts.map((a: AlertItem) => a.type)).toEqual(["host.memory"]);
  });

  it("sends a resolution to webhooks now and holds it for one grouped email", async () => {
    mocks.clear.mockResolvedValue([{ about: "host", severity: "warning", sentAt: new Date(now.getTime() - 60_000), detail: obs("host.memory", "host").item }]);
    await notifyObservations("org1", ["host.memory"], [], now);
    const [, event] = mocks.emit.mock.calls[0];
    expect(event).toMatchObject({ type: "alert.resolved", held: true });
    expect(event.quiet).toBeUndefined();
    expect(mocks.hold).toHaveBeenCalledWith("org1", [expect.objectContaining({ type: "host.memory", about: "host", resolvedAt: now.toISOString() })], now);
  });

  it("sends held resolutions before an alert that fires", async () => {
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(mocks.sendHeld).toHaveBeenCalledWith("org1", now.getTime(), true);
    expect(mocks.sendHeld.mock.invocationCallOrder[0]).toBeLessThan(mocks.emit.mock.invocationCallOrder[0]);
  });

  it("clears quietly when the org turned the category off", async () => {
    mocks.settings.mockResolvedValue({ categories: { backups: true, host: false, apps: true }, batchWindowMinutes: 30 });
    mocks.clear.mockResolvedValue([{ about: "host", severity: "warning", sentAt: now, detail: { title: "x" } }]);
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(mocks.claim).toHaveBeenCalledWith("org1", "host.memory", [], 1, now);
    expect(mocks.clear).toHaveBeenCalledWith("org1", "host.memory", [], now);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("clears anomaly alerts without a resolved email", async () => {
    mocks.settings.mockResolvedValue({ categories: { anomalies: true }, batchWindowMinutes: 30 });
    mocks.clear.mockImplementation(async (_org: string, type: Observation["type"]) =>
      [{ about: "a1", severity: "warning", sentAt: new Date(now.getTime() - 60_000), detail: obs(type, "a1").item }],
    );
    const { resolved } = await notifyObservations("org1", ["app.anomaly", "app.new-process", "app.new-port"], [], now);
    expect(mocks.clear).toHaveBeenCalledTimes(3);
    expect(resolved).toEqual([]);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.hold).not.toHaveBeenCalled();
  });

  it("keeps a holding subject in the margin from clearing without sending it", async () => {
    const margin = { ...obs("host.cpu", "host"), fires: false };
    await notifyObservations("org1", ["host.cpu"], [margin], now);
    expect(mocks.claim).toHaveBeenCalledWith("org1", "host.cpu", [], 1, now);
    expect(mocks.clear).toHaveBeenCalledWith("org1", "host.cpu", ["host"], now);
  });
});
