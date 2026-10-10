import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem, BusEvent } from "@/lib/bus/events";
import type { IncidentRow } from "@/lib/db/schema";
import type { IncidentRef } from "@/lib/incidents/types";

// What receivers get for an incident: webhook bodies, email thread headers and push updates.

const h = vi.hoisted(() => ({
  calls: [] as { url: string; init: RequestInit }[],
  reply: (() => new Response("{}", { status: 200 })) as () => Response,
}));

vi.mock("@/lib/security/safe-fetch", () => ({
  safeFetch: async (url: string, init: RequestInit) => {
    h.calls.push({ url, init });
    return h.reply();
  },
}));
vi.mock("@/lib/security/outbound-policy", () => ({ getOutboundPolicy: async () => ({ allowlist: [] }) }));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "node-a" }));
vi.mock("@/lib/time-zone-settings", () => ({ getOrgTimeZone: async () => "UTC" }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: async () => ({ categories: {} }) }));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://vardo.example.com");

const { WebhookNotificationChannel, webhookPayloads } = await import("@/lib/notifications/webhook-channel");
const { NtfyNotificationChannel } = await import("@/lib/notifications/ntfy-channel");
const { DiscordNotificationChannel } = await import("@/lib/notifications/discord-channel");
const { TelegramNotificationChannel } = await import("@/lib/notifications/telegram-channel");
const { incidentRef } = await import("@/lib/incidents/key");
const { incidentThread, smtpThread, threadHeaders } = await import("@/lib/email/thread");
const { sendViaPouch } = await import("@/lib/email/pouch");
const { emailsEvent } = await import("@/lib/notifications/delivery-policy");
const { notificationSubject } = await import("@/lib/email/subjects");

const now = new Date("2026-10-10T12:00:00Z");

function ref(transition: IncidentRef["transition"], overrides: Partial<IncidentRef> = {}): IncidentRef {
  const resolved = transition === "resolved";
  return {
    id: "inc_7k2m",
    key: "app:a1:app.restart-loop",
    kind: "app.restart-loop",
    state: resolved ? "resolved" : "open",
    transition,
    severity: "critical",
    peakSeverity: "critical",
    subject: { type: "app", id: "a1" },
    appId: "a1",
    title: "Shop keeps restarting",
    openedAt: "2026-10-10T10:00:00.000Z",
    updatedAt: now.toISOString(),
    resolvedAt: resolved ? now.toISOString() : null,
    ...(resolved ? { durationMs: 7_200_000 } : {}),
    updates: 0,
    url: "https://vardo.example.com/apps/a1",
    ...overrides,
  };
}

const item = (incident?: IncidentRef, about = "a1"): AlertItem => ({
  type: "app.restart-loop",
  about,
  severity: "critical",
  title: "Shop keeps restarting",
  detail: "Its container exits soon after each start.",
  appId: about,
  appName: "Shop",
  ...(incident ? { incident } : {}),
});

const fired = (incident: IncidentRef): BusEvent => ({
  id: "evt_1",
  type: "alert.fired",
  title: "Shop keeps restarting",
  message: "Shop keeps restarting",
  alerts: [item(incident)],
  incident,
});

const resolved = (incident: IncidentRef, quiet = false): BusEvent => ({
  id: "evt_2",
  type: "alert.resolved",
  title: "Resolved: Shop keeps restarting",
  message: "Shop keeps restarting",
  alerts: [{ ...item(incident), firedAt: incident.openedAt, resolvedAt: now.toISOString() }],
  incident,
  ...(quiet ? { quiet } : {}),
});

const body = (i = 0) => JSON.parse(h.calls[i].init.body as string);

beforeEach(() => {
  h.calls.length = 0;
  h.reply = () => new Response("{}", { status: 200 });
});

describe("webhook payload", () => {
  it("adds version, a stable id and the incident, and keeps the existing fields", async () => {
    await new WebhookNotificationChannel({ url: "https://hooks.example.com/in" }).send(fired(ref("opened")));
    expect(h.calls).toHaveLength(1);
    expect(body()).toMatchObject({
      version: 2,
      id: "evt_1",
      type: "alert.fired",
      title: "Shop keeps restarting",
      message: "Shop keeps restarting",
      alerts: [expect.objectContaining({ type: "app.restart-loop", about: "a1" })],
      incident: { id: "inc_7k2m", key: "app:a1:app.restart-loop", state: "open", transition: "opened", kind: "app.restart-loop", severity: "critical", openedAt: "2026-10-10T10:00:00.000Z", resolvedAt: null, url: "https://vardo.example.com/apps/a1" },
    });
    expect(typeof body().timestamp).toBe("string");
  });

  it("keeps one incident id from open through update to resolve", () => {
    const ids = [fired(ref("opened")), fired(ref("updated", { reason: "escalated", updates: 1 })), resolved(ref("resolved"))].map(
      (e) => webhookPayloads(e)[0].incident as IncidentRef,
    );
    expect(new Set(ids.map((i) => i.id))).toEqual(new Set(["inc_7k2m"]));
    expect(ids.map((i) => i.transition)).toEqual(["opened", "updated", "resolved"]);
    expect(ids[2]).toMatchObject({ state: "resolved", durationMs: 7_200_000 });
  });

  it("splits a notice covering several incidents into one body each", () => {
    const a = ref("opened");
    const b = ref("opened", { id: "inc_9x", key: "app:a2:app.restart-loop", subject: { type: "app", id: "a2" } });
    const event: BusEvent = { id: "evt_3", type: "alert.fired", title: "2 alerts", message: "x", alerts: [item(a), item(b, "a2")] };
    const bodies = webhookPayloads(event);
    expect(bodies.map((x) => (x.incident as IncidentRef).id)).toEqual(["inc_7k2m", "inc_9x"]);
    expect(bodies.map((x) => x.id)).toEqual(["evt_3:inc_7k2m", "evt_3:inc_9x"]);
    expect(bodies.every((x) => (x.alerts as unknown[]).length === 1 && x.version === 2)).toBe(true);
  });

  it("gives a one-off event its id and no incident", () => {
    const [payload] = webhookPayloads({ id: "evt_4", type: "system.update-available", title: "t", message: "m", remoteHead: "a", localHead: "b" });
    expect(payload).toMatchObject({ version: 2, id: "evt_4", type: "system.update-available" });
    expect(payload).not.toHaveProperty("incident");
  });

  it("still posts a quiet resolution, which email and push skip", async () => {
    const event = resolved(ref("resolved"), true);
    await new WebhookNotificationChannel({ url: "https://hooks.example.com/in" }).send(event);
    expect(body()).toMatchObject({ quiet: true, incident: { transition: "resolved" } });
    expect(emailsEvent(event, { categories: {} })).toBe(false);
  });
});

describe("incident payloads carry no sensitive content", () => {
  it("holds whitelisted fields and Vardo's wording, never log lines or env values", () => {
    const secretLine = "Error: connect ECONNREFUSED postgres://admin:hunter2-secret@db:5432";
    const row: IncidentRow = {
      id: "inc_1",
      organizationId: "org1",
      key: "volume:backup:a1/data:backup.failure",
      kind: "backup.failure",
      subjectType: "volume",
      subjectId: "backup:a1/data",
      appId: "a1",
      title: "Backup of Shop data failed",
      severity: "critical",
      peakSeverity: "critical",
      state: "open",
      openedAt: now,
      updatedAt: now,
      resolvedAt: null,
      updateCount: 0,
      reopenCount: 0,
      lastNotifiedState: null,
      lastNotifiedAt: null,
      channelMessages: { ch1: "123" },
    };
    const incident = incidentRef(row, "opened");
    expect(Object.keys(incident).sort()).toEqual(
      ["appId", "id", "key", "kind", "openedAt", "peakSeverity", "resolvedAt", "severity", "state", "subject", "title", "transition", "updatedAt", "updates", "url"].sort(),
    );
    const event: BusEvent = {
      id: "evt_5",
      type: "alert.fired",
      title: "Backup of Shop data failed",
      message: "x",
      alerts: [{ type: "backup.failure", about: "backup:a1/data", severity: "critical", title: row.title, detail: secretLine, facts: [{ label: "Log", value: secretLine }], incident }],
      incident,
    };
    const sent = JSON.stringify(webhookPayloads(event)[0].incident);
    expect(sent).not.toContain("hunter2");
    expect(sent).not.toContain("ECONNREFUSED");
    expect(sent).not.toContain("channelMessages");
  });
});

describe("email threading", () => {
  it("roots the thread on the incident and replies to it after", () => {
    expect(incidentThread(ref("opened"), "vardo.example.com")).toEqual({ root: "<inc_7k2m@vardo.example.com>", reply: false });
    expect(incidentThread(ref("updated"), "vardo.example.com")).toEqual({ root: "<inc_7k2m@vardo.example.com>", reply: true });
    expect(incidentThread(ref("resolved"), "vardo.example.com").reply).toBe(true);
  });

  it("sets Message-ID over SMTP and In-Reply-To and References on replies", () => {
    const root = "<inc_7k2m@vardo.example.com>";
    expect(smtpThread({ root, reply: false })).toEqual({ messageId: root });
    expect(smtpThread({ root, reply: true })).toEqual({ inReplyTo: root, references: root });
    expect(threadHeaders({ root, reply: false })).toEqual({ References: root });
    expect(threadHeaders({ root, reply: true })).toEqual({ "In-Reply-To": root, References: root });
  });

  it("keeps the subject constant, with a resolved prefix", () => {
    const ctx = { instanceName: "node-a" };
    const escalated = fired(ref("updated"));
    if (escalated.type === "alert.fired") escalated.alerts[0].title = "Shop restarted 9 times";
    expect(notificationSubject(fired(ref("opened")), ctx)).toContain("✗ Shop keeps restarting");
    expect(notificationSubject(escalated, ctx)).toContain("✗ Shop keeps restarting");
    expect(notificationSubject(resolved(ref("resolved")), ctx)).toContain("✓ Resolved · Shop keeps restarting");
  });

  it("sends thread headers to Pouch, and drops them when the domain refuses custom headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "validation_failed", field: "headers", message: "Custom headers aren't supported" } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "msg_1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const thread = { root: "<inc_7k2m@vardo.example.com>", reply: true };
    const result = await sendViaPouch(
      { provider: "pouch", apiKey: "pk_test" },
      { to: "ops@example.com", subject: "s", html: "<p>h</p>", text: "t", from: "Vardo <alerts@example.com>", thread },
    );
    expect(result).toEqual({ success: true, messageId: "msg_1" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).headers).toEqual({ "In-Reply-To": thread.root, References: thread.root });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).headers).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("push updates", () => {
  it("ntfy replaces the incident's notification through its sequence id", async () => {
    await new NtfyNotificationChannel({ topic: "vardo-test" }).send(fired(ref("opened")));
    await new NtfyNotificationChannel({ topic: "vardo-test" }).send(resolved(ref("resolved")));
    expect(body(0).sequence_id).toBe("inc_7k2m");
    expect(body(1).sequence_id).toBe("inc_7k2m");
  });

  it("Discord edits the opening message when the incident resolves", async () => {
    const channel = new DiscordNotificationChannel({ webhookUrl: "https://discord.com/api/webhooks/123456789012345678/fakeTokenExample_-0" });
    await channel.send(resolved(ref("resolved")), { priorMessageId: "111222333" });
    expect(h.calls[0].init.method).toBe("PATCH");
    expect(h.calls[0].url).toBe("https://discord.com/api/webhooks/123456789012345678/fakeTokenExample_-0/messages/111222333");
  });

  it("Discord posts a new message when the original is gone", async () => {
    let n = 0;
    h.reply = () => (n++ === 0 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ id: "999" }), { status: 200 }));
    const channel = new DiscordNotificationChannel({ webhookUrl: "https://discord.com/api/webhooks/123456789012345678/fakeTokenExample_-0" });
    const receipt = await channel.send(resolved(ref("resolved")), { priorMessageId: "111222333" });
    expect(h.calls[1].init.method).toBe("POST");
    expect(receipt.providerMessageIds).toEqual(["999"]);
  });

  it("Telegram replies to the opening message", async () => {
    h.reply = () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 });
    const channel = new TelegramNotificationChannel({ botToken: "123456789:AAFakeTokenExampleFakeToken_0123456", chatId: "-100123" });
    await channel.send(resolved(ref("resolved")), { priorMessageId: "42" });
    expect(body().reply_parameters).toEqual({ message_id: 42, allow_sending_without_reply: true });
  });
});
