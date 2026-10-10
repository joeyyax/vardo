import { describe, it, expect, vi, beforeEach } from "vitest";

// Creating and updating channels validates the config for the channel's type and stores credentials sealed.

process.env.ENCRYPTION_MASTER_KEY ??= "b".repeat(64);

const h = vi.hoisted(() => ({
  stored: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { notificationChannels: { findFirst: async () => h.stored } },
    insert: () => ({
      values: (row: Record<string, unknown>) => ({ returning: async () => (h.inserted.push(row), [row]) }),
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({ where: () => ({ returning: async () => (h.updated.push(row), [row]) }) }),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { channelCreateSchema, createChannelRow, updateChannelRow, ChannelConfigError } = await import("@/lib/notifications/channels");
const { sealChannelConfig, openChannelConfig } = await import("@/lib/notifications/channel-config");

const ORG = "org-1";

beforeEach(() => {
  h.stored = null;
  h.inserted.length = 0;
  h.updated.length = 0;
});

describe("channelCreateSchema", () => {
  it("normalizes the config for its type", () => {
    const parsed = channelCreateSchema.parse({ name: "Phone", type: "ntfy", config: { topic: "vardo-test", extra: "dropped" } });
    expect(parsed.config).toEqual({ serverUrl: "https://ntfy.sh", topic: "vardo-test" });
    expect(parsed.enabled).toBe(true);
  });

  it("names the problem when the config doesn't fit the type", () => {
    const result = channelCreateSchema.safeParse({ name: "Phone", type: "telegram", config: { botToken: "x", chatId: "1" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["config"], message: expect.stringContaining("Bot token") });
  });

  it("refuses an unknown type", () => {
    expect(channelCreateSchema.safeParse({ name: "x", type: "carrier-pigeon", config: {} }).success).toBe(false);
  });
});

describe("createChannelRow", () => {
  it("stores ntfy credentials encrypted", async () => {
    const input = channelCreateSchema.parse({ name: "Phone", type: "ntfy", config: { topic: "vardo-test", accessToken: "tk_fake0000" } });
    await createChannelRow(ORG, input);
    const config = h.inserted[0].config as Record<string, string>;
    expect(config.topic).not.toBe("vardo-test");
    expect(config.accessToken).not.toBe("tk_fake0000");
    expect(openChannelConfig({ organizationId: ORG, config })).toEqual({ serverUrl: "https://ntfy.sh", topic: "vardo-test", accessToken: "tk_fake0000" });
  });
});

describe("updateChannelRow", () => {
  const pushover = { userKey: "u".repeat(30), appToken: "a".repeat(30) };
  const storedPushover = () => ({
    id: "c1",
    organizationId: ORG,
    name: "Phone",
    type: "pushover",
    config: sealChannelConfig({ ...pushover }, ORG),
  });

  it("keeps a stored credential the client sends back masked", async () => {
    h.stored = storedPushover();
    await updateChannelRow(ORG, "c1", { config: { userKey: "****", appToken: "b".repeat(30) } });
    expect(openChannelConfig({ organizationId: ORG, config: h.updated[0].config })).toEqual({ userKey: pushover.userKey, appToken: "b".repeat(30) });
  });

  it("validates against the stored type and throws on a bad config", async () => {
    h.stored = storedPushover();
    await expect(updateChannelRow(ORG, "c1", { config: { userKey: "****", appToken: "short" } })).rejects.toThrow(ChannelConfigError);
    expect(h.updated).toHaveLength(0);
  });

  it("refuses a Discord URL on another host", async () => {
    h.stored = {
      id: "c1",
      organizationId: ORG,
      name: "Chat",
      type: "discord",
      config: sealChannelConfig({ webhookUrl: "https://discord.com/api/webhooks/1/x" }, ORG),
    };
    await expect(updateChannelRow(ORG, "c1", { config: { webhookUrl: "http://169.254.169.254/api/webhooks/1/x" } })).rejects.toThrow(
      /Discord webhook URL/,
    );
  });

  it("returns null for a channel outside the org", async () => {
    expect(await updateChannelRow(ORG, "nope", { config: { userKey: "x", appToken: "y" } })).toBeNull();
  });
});
