import { describe, it, expect, vi, beforeEach } from "vitest";

const { appsFindFirst, orgVarsFindMany } = vi.hoisted(() => ({
  appsFindFirst: vi.fn(),
  orgVarsFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apps: { findFirst: appsFindFirst },
      orgEnvVars: { findMany: orgVarsFindMany },
    },
  },
}));

const { redactEvent } = await import("@/lib/notifications/redact-event");
const { createChannel } = await import("@/lib/notifications/factory");
const { WebhookNotificationChannel, SlackNotificationChannel } = await import("@/lib/notifications/webhook-channel");
const { EmailNotificationChannel } = await import("@/lib/notifications/email-channel");
const { NtfyNotificationChannel } = await import("@/lib/notifications/ntfy-channel");
const { DiscordNotificationChannel } = await import("@/lib/notifications/discord-channel");
const { TelegramNotificationChannel } = await import("@/lib/notifications/telegram-channel");
const { PushoverNotificationChannel } = await import("@/lib/notifications/pushover-channel");

const ORG = "org-1";

const cronEvent = {
  type: "cron.failed" as const,
  title: "Cron failed: backup (api)",
  message: "pg_dump postgres://admin:db-pass-123@db/app\nusing token tok3n-value-abc",
  cronJobId: "job-1",
  cronJobName: "backup",
  appId: "app-1",
  projectName: "api",
  durationMs: 12,
  extra: { tail: ["line one", "ENCRYPTION_MASTER_KEY=deadbeefcafe"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  appsFindFirst.mockResolvedValue({
    name: "api",
    displayName: "API",
    envContent: "API_TOKEN=tok3n-value-abc\nNODE_ENV=production\n",
  });
  orgVarsFindMany.mockResolvedValue([{ key: "SHARED", value: "shared-org-value", isSecret: true }]);
});

describe("redactEvent", () => {
  it("removes the app's secret env values and secret shapes from every string", async () => {
    const out = JSON.stringify(await redactEvent(ORG, cronEvent as never));
    expect(out).not.toContain("tok3n-value-abc");
    expect(out).not.toContain("db-pass-123");
    expect(out).not.toContain("deadbeefcafe");
    expect(out).toContain("Cron failed: backup (api)");
    expect(out).toContain("line one");
  });

  it("removes org shared values flagged secret", async () => {
    const event = { ...cronEvent, message: "echo shared-org-value" };
    expect(JSON.stringify(await redactEvent(ORG, event as never))).not.toContain("shared-org-value");
  });

  it("falls back to patterns when env can't be loaded", async () => {
    appsFindFirst.mockRejectedValue(new Error("db down"));
    const out = JSON.stringify(await redactEvent(ORG, cronEvent as never));
    expect(out).not.toContain("db-pass-123");
  });
});

describe("createChannel", () => {
  it.each([
    ["webhook", WebhookNotificationChannel, { url: "https://example.com/hook" }],
    ["slack", SlackNotificationChannel, { webhookUrl: "https://hooks.slack.com/x" }],
    ["email", EmailNotificationChannel, { recipients: ["ops@example.com"] }],
    ["ntfy", NtfyNotificationChannel, { topic: "vardo-test" }],
    ["discord", DiscordNotificationChannel, { webhookUrl: "https://discord.com/api/webhooks/1/x" }],
    ["telegram", TelegramNotificationChannel, { botToken: "1:x", chatId: "1" }],
    ["pushover", PushoverNotificationChannel, { userKey: "u", appToken: "a" }],
  ] as const)("redacts before a %s channel sends", async (type, Channel, config) => {
    const spy = vi.spyOn(Channel.prototype, "send").mockResolvedValue({});
    await createChannel({ type, organizationId: ORG, config }).send(cronEvent as never);
    expect(JSON.stringify(spy.mock.calls[0][0])).not.toContain("tok3n-value-abc");
    spy.mockRestore();
  });
});
