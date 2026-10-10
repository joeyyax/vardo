import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentRef } from "@/lib/incidents/types";

const m = vi.hoisted(() => ({ emit: vi.fn(), open: vi.fn(), resolve: vi.fn() }));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit }));
vi.mock("@/lib/incidents/store", () => ({
  openIncident: m.open,
  resolveIncidents: m.resolve,
  safely: async <T,>(_: string, fn: () => Promise<T>) => fn(),
}));

const { emitSystemIncident, resolveSystemIncident } = await import("@/lib/incidents/system");
const { incidentKey } = await import("@/lib/incidents/key");

const now = new Date("2026-10-10T12:00:00Z");
const ref = (transition: IncidentRef["transition"]): IncidentRef => ({
  id: "inc_svc",
  key: "service:redis:system.service-down",
  kind: "system.service-down",
  state: transition === "resolved" ? "resolved" : "open",
  transition,
  severity: "critical",
  peakSeverity: "critical",
  subject: { type: "service", id: "redis" },
  title: "Service degraded: redis",
  openedAt: "2026-10-10T11:00:00.000Z",
  updatedAt: now.toISOString(),
  resolvedAt: transition === "resolved" ? now.toISOString() : null,
  updates: 0,
  url: "https://vardo.example.com",
});

beforeEach(() => vi.clearAllMocks());

describe("system incidents", () => {
  it("keys services and certificates by name", () => {
    expect(incidentKey("system.service-down", "redis")).toBe("service:redis:system.service-down");
    expect(incidentKey("system.cert-expiring", "shop.example.com")).toBe("domain:shop.example.com:system.cert-expiring");
    expect(incidentKey("system.loop-failing", "loop:git-poll")).toBe("service:loop:git-poll:system.loop-failing");
  });

  it("opens one incident per org and carries it on each org's notice", async () => {
    m.open.mockResolvedValue(ref("opened"));
    await emitSystemIncident(
      ["org1", "org2"],
      { type: "system.service-down", title: "Service degraded: redis", message: "m", service: "redis", description: "Redis" },
      { kind: "system.service-down", about: "redis", title: "Service degraded: redis", severity: "critical" },
      now,
    );
    expect(m.open).toHaveBeenCalledTimes(2);
    expect(m.emit.mock.calls.map(([org, e]) => [org, e.incident.id])).toEqual([["org1", "inc_svc"], ["org2", "inc_svc"]]);
  });

  it("sends a recovery only where an incident was open", async () => {
    m.resolve.mockImplementation(async (org: string) => (org === "org1" ? new Map([["redis", ref("resolved")]]) : new Map()));
    await resolveSystemIncident(["org1", "org2"], "system.service-down", "redis", "redis is responding again.", now);
    expect(m.emit).toHaveBeenCalledTimes(1);
    const [org, event] = m.emit.mock.calls[0];
    expect(org).toBe("org1");
    expect(event).toMatchObject({
      type: "alert.resolved",
      title: "Resolved: Service degraded: redis",
      incident: { id: "inc_svc", transition: "resolved" },
      alerts: [{ type: "system.service-down", about: "redis", detail: "redis is responding again." }],
    });
    expect(event.quiet).toBeUndefined();
  });
});
