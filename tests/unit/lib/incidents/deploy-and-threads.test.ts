import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import type { IncidentRef } from "@/lib/incidents/types";

const m = vi.hoisted(() => ({
  open: vi.fn(),
  resolve: vi.fn(),
  channelMessage: vi.fn(),
  remember: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/incidents/store", () => ({
  openIncident: m.open,
  resolveIncidents: m.resolve,
  channelMessage: m.channelMessage,
  rememberChannelMessage: m.remember,
  safely: async <T,>(_: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/notifications/redact-event", () => ({ redactEvent: async (_: string, e: BusEvent) => e }));
vi.mock("@/lib/notifications/channel-config", () => ({ openChannelConfig: (row: { config: unknown }) => row.config }));
vi.mock("@/lib/notifications/telegram-channel", () => ({
  TelegramNotificationChannel: class {
    send = m.send;
  },
}));

const { deployIncident } = await import("@/lib/incidents/deploy");
const { createChannel } = await import("@/lib/notifications/factory");

const incident = (transition: IncidentRef["transition"]): IncidentRef => ({
  id: "inc_1",
  key: "app:a1/env1:deploy.failed",
  kind: "deploy.failed",
  state: transition === "resolved" ? "resolved" : "open",
  transition,
  severity: "critical",
  peakSeverity: "critical",
  subject: { type: "app", id: "a1/env1" },
  title: "Shop failed to deploy",
  openedAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  resolvedAt: null,
  updates: 0,
  url: "https://vardo.example.com/apps/a1",
});

beforeEach(() => vi.clearAllMocks());

describe("deployIncident", () => {
  it("opens on failure per app and environment", async () => {
    m.open.mockResolvedValue(incident("opened"));
    await deployIncident("org1", { appId: "a1", deploymentId: "d1", displayName: "Shop", environmentId: "env1" }, false);
    expect(m.open).toHaveBeenCalledWith("org1", expect.objectContaining({ kind: "deploy.failed", about: "a1/env1", title: "Shop failed to deploy" }), expect.any(Date));
  });

  it("resolves on the next success", async () => {
    m.resolve.mockResolvedValue(new Map([["a1/env1", incident("resolved")]]));
    const ref = await deployIncident("org1", { appId: "a1", deploymentId: "d2", displayName: "Shop", environmentId: "env1" }, true);
    expect(m.resolve).toHaveBeenCalledWith("org1", "deploy.failed", ["a1/env1"], expect.any(Date));
    expect(ref?.transition).toBe("resolved");
  });

  it("carries nothing on a success with no open failure", async () => {
    m.resolve.mockResolvedValue(new Map());
    expect(await deployIncident("org1", { appId: "a1", deploymentId: "d2", displayName: "Shop", environmentId: null }, true)).toBeNull();
  });
});

describe("threaded push sends", () => {
  const row = { id: "ch1", type: "telegram" as const, organizationId: "org1", config: {} };
  const event = (transition: IncidentRef["transition"]): BusEvent => ({
    type: "deploy.failed",
    title: "t",
    message: "m",
    projectName: "Shop",
    appId: "a1",
    deploymentId: "d1",
    incident: incident(transition),
  });

  it("remembers the opening message", async () => {
    m.send.mockResolvedValue({ providerMessageIds: ["42"] });
    await createChannel(row).send(event("opened"));
    expect(m.channelMessage).not.toHaveBeenCalled();
    expect(m.remember).toHaveBeenCalledWith("inc_1", "ch1", "42");
  });

  it("passes the opening message to later sends and keeps it", async () => {
    m.channelMessage.mockResolvedValue("42");
    m.send.mockResolvedValue({ providerMessageIds: ["43"] });
    await createChannel(row).send(event("resolved"));
    expect(m.send).toHaveBeenCalledWith(expect.anything(), { priorMessageId: "42" });
    expect(m.remember).not.toHaveBeenCalled();
  });
});
