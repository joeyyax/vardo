import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem, BusEvent } from "@/lib/bus/events";
import type { IncidentRef } from "@/lib/incidents/types";

// An alert pass through the email channel to the body posted to Pouch.

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const m = vi.hoisted(() => ({
  emit: vi.fn(),
  claim: vi.fn(),
  clear: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: m.emit }));
vi.mock("@/lib/notifications/throttle", () => ({ claimNotifications: m.claim, clearNotifications: m.clear, clearSubjects: vi.fn(async () => []) }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: async () => ({ categories: { host: true } }) }));
vi.mock("@/lib/incidents/store", () => ({
  openIncident: m.open,
  resolveIncidents: m.resolve,
  openSeverities: async () => new Map(),
  lowerSeverity: vi.fn(),
  safely: async <T,>(_: string, fn: () => Promise<T>, fallback: T) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));
vi.mock("@/lib/system-settings", () => ({
  getEmailProviderConfig: async () => ({ provider: "pouch", apiKey: "pk_test", fromEmail: "alerts@example.com" }),
  getInstanceDisplayName: async () => "Example Home",
}));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/email/series", () => ({ loadMailSeries: async () => ({}) }));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://vardo.yax.me");

const { notifyObservations } = await import("@/lib/notifications/observations");
const { EmailNotificationChannel } = await import("@/lib/notifications/email-channel");

const opened = new Date("2026-10-11T05:00:00Z");
const cleared = new Date("2026-10-11T07:43:00Z");
const root = "<inc_swap1@vardo.yax.me>";

const swap: AlertItem = { type: "host.swap", about: "host", severity: "warning", title: "Swap 55% used", detail: "Paging." };

function ref(transition: IncidentRef["transition"]): IncidentRef {
  const resolved = transition === "resolved";
  return {
    id: "inc_swap1",
    key: "host:local:host.swap",
    kind: "host.swap",
    state: resolved ? "resolved" : "open",
    transition,
    severity: "warning",
    peakSeverity: "warning",
    subject: { type: "host", id: "local" },
    title: "Swap 55% used",
    openedAt: opened.toISOString(),
    updatedAt: (resolved ? cleared : opened).toISOString(),
    resolvedAt: resolved ? cleared.toISOString() : null,
    updates: 0,
    url: "https://vardo.yax.me/metrics",
  };
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 202 }));
const posted = () => JSON.parse((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string);

async function deliver(): Promise<void> {
  const event = m.emit.mock.calls.at(-1)![1] as BusEvent;
  await new EmailNotificationChannel({ recipients: ["ops@example.com"] }, "org1").send(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  m.claim.mockImplementation(async (_o: string, _t: string, reqs: { about: string }[]) => reqs.map((r) => ({ about: r.about, previous: null })));
  m.clear.mockResolvedValue([]);
  m.resolve.mockResolvedValue(new Map());
});

const clearedRow = { about: "host", severity: "warning", sentAt: opened, detail: swap };

describe("incident email threading, alert pass to Pouch", () => {
  it("roots the opening email on the incident and threads the resolution under it", async () => {
    m.open.mockResolvedValue(ref("opened"));
    await notifyObservations("org1", ["host.swap"], [{ type: "host.swap", about: "host", severity: "warning", fires: true, item: swap }], opened);
    await deliver();
    expect(posted()).toMatchObject({ subject: "Example Home · ⚠ Swap 55% used", headers: { References: root } });
    expect(posted().headers).not.toHaveProperty("In-Reply-To");

    m.clear.mockResolvedValue([clearedRow]);
    m.resolve.mockResolvedValue(new Map([["host", ref("resolved")]]));
    await notifyObservations("org1", ["host.swap"], [], cleared);
    await deliver();
    expect(posted()).toMatchObject({ subject: "Example Home · ✓ Resolved · Swap 55% used", headers: { "In-Reply-To": root, References: root } });
  });

  it("sends a resolution without thread headers when the alert has no incident", async () => {
    m.clear.mockResolvedValue([clearedRow]);
    await notifyObservations("org1", ["host.swap"], [], cleared);
    await deliver();
    expect(posted().subject).toBe("Example Home · ✓ Resolved · Swap 55% used");
    expect(posted()).not.toHaveProperty("headers");
  });
});
