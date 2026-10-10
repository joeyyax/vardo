import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "@/lib/bus/events";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  claim: vi.fn(),
  clear: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/throttle", () => ({ claimNotifications: mocks.claim, clearNotifications: mocks.clear }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: mocks.settings }));

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

  it("clears quietly when the org turned the category off", async () => {
    mocks.settings.mockResolvedValue({ categories: { backups: true, host: false, apps: true }, batchWindowMinutes: 30 });
    mocks.clear.mockResolvedValue([{ about: "host", severity: "warning", sentAt: now, detail: { title: "x" } }]);
    await notifyObservations("org1", ["host.memory"], [obs("host.memory", "host")], now);
    expect(mocks.claim).toHaveBeenCalledWith("org1", "host.memory", [], 1, now);
    expect(mocks.clear).toHaveBeenCalledWith("org1", "host.memory", [], now);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps a holding subject in the margin from clearing without sending it", async () => {
    const margin = { ...obs("host.cpu", "host"), fires: false };
    await notifyObservations("org1", ["host.cpu"], [margin], now);
    expect(mocks.claim).toHaveBeenCalledWith("org1", "host.cpu", [], 1, now);
    expect(mocks.clear).toHaveBeenCalledWith("org1", "host.cpu", ["host"], now);
  });
});
