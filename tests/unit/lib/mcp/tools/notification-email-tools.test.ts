import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "@/lib/mcp/auth";

// Notification channel tools stay inside the token's orgs; email settings tools exist only with the admin scope.

const h = vi.hoisted(() => ({
  channel: null as Record<string, unknown> | null,
  canAccess: vi.fn(async () => true),
  instanceAdmin: vi.fn(async () => true),
  stored: null as Record<string, unknown> | null,
  saved: [] as Record<string, unknown>[],
  testSend: vi.fn(async () => ({ ok: true, message: "Sent.", providerStatus: 200 })),
  deleteRow: vi.fn(async () => "c1"),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { notificationChannels: { findFirst: async () => h.channel, findMany: async () => [] } } },
}));
vi.mock("@/lib/mcp/scope", () => ({
  canAccessOrg: h.canAccess,
  accessibleOrgIds: async () => ["org-1"],
  resolveTargetOrg: async () => "org-1",
  orgFilter: () => undefined,
  accessDenied: (resource: string) => ({
    content: [{ type: "text", text: JSON.stringify({ error: `${resource} not found or access denied` }) }],
    isError: true,
  }),
  canAdminInstance: async (context: McpAuthContext) => Boolean(context.adminScope) && (await h.instanceAdmin()),
}));
vi.mock("@/lib/notifications/test-send", () => ({ sendTestNotification: h.testSend }));
vi.mock("@/lib/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("@/lib/notifications/channels")>()),
  deleteChannelRow: h.deleteRow,
}));
vi.mock("@/lib/system-settings", () => ({
  getEmailProviderConfig: async () => h.stored,
  setSystemSetting: async (_key: string, value: string) => {
    h.saved.push(JSON.parse(value));
    h.stored = JSON.parse(value);
  },
}));
vi.mock("@/lib/config/provider-restrictions", () => ({ isSmtpAllowed: () => true }));

import { registerNotificationChannelTools } from "@/lib/mcp/tools/notification-channels";
import { registerEmailSettingsTools } from "@/lib/mcp/tools/email-settings";

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function serverFor(context: McpAuthContext) {
  const handlers = new Map<string, Handler>();
  const server = { tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest.at(-1) as Handler) } as unknown as McpServer;
  registerNotificationChannelTools(server, context);
  registerEmailSettingsTools(server, context);
  return handlers;
}

const body = (r: Result) => JSON.parse(r.content[0].text);
const plain = { userId: "u1", organizationId: "org-1", crossOrg: false } as McpAuthContext;
const admin = { ...plain, adminScope: true } as McpAuthContext;

beforeEach(() => {
  vi.clearAllMocks();
  h.channel = { id: "c1", organizationId: "org-1", name: "Ops", type: "webhook", config: {} };
  h.canAccess.mockResolvedValue(true);
  h.instanceAdmin.mockResolvedValue(true);
  h.stored = null;
  h.saved.length = 0;
});

describe("notification channel tools", () => {
  it("registers list, create, update, delete and test", () => {
    expect([...serverFor(plain).keys()].sort()).toEqual([
      "vardo_create_notification_channel",
      "vardo_delete_notification_channel",
      "vardo_list_notification_channels",
      "vardo_test_notification_channel",
      "vardo_update_notification_channel",
    ]);
  });

  it("test-sends through a channel the token may manage and reports the result", async () => {
    const result = await serverFor(plain).get("vardo_test_notification_channel")!({ channelId: "c1" });
    expect(h.canAccess).toHaveBeenCalledWith(plain, "org-1", "org.notifications.manage");
    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({ ok: true, message: "Sent.", providerStatus: 200 });
  });

  it("flags a failed test send as an error", async () => {
    h.testSend.mockResolvedValueOnce({ ok: false, message: "The endpoint answered 500.", providerStatus: 500 });
    const result = await serverFor(plain).get("vardo_test_notification_channel")!({ channelId: "c1" });
    expect(result.isError).toBe(true);
    expect(body(result).providerStatus).toBe(500);
  });

  it.each(["vardo_test_notification_channel", "vardo_delete_notification_channel", "vardo_update_notification_channel"])(
    "%s refuses a channel outside the token's reach",
    async (tool) => {
      h.canAccess.mockResolvedValue(false);
      const result = await serverFor(plain).get(tool)!({ channelId: "c1", name: "x" });
      expect(result.isError).toBe(true);
      expect(h.testSend).not.toHaveBeenCalled();
      expect(h.deleteRow).not.toHaveBeenCalled();
    },
  );

  it("rejects a config that doesn't match the channel type", async () => {
    const result = await serverFor(plain).get("vardo_create_notification_channel")!({
      name: "Ops",
      type: "slack",
      config: { url: "https://example.com/hook" },
    });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/doesn't match the channel type/);
  });
});

describe("email settings tools", () => {
  it("aren't registered without the admin scope", () => {
    const tools = [...serverFor(plain).keys()];
    expect(tools).not.toContain("vardo_get_email_settings");
    expect(tools).not.toContain("vardo_update_email_settings");
  });

  it("refuse once the token's user is no longer an instance admin", async () => {
    h.instanceAdmin.mockResolvedValue(false);
    const result = await serverFor(admin).get("vardo_get_email_settings")!({});
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/admin scope/);
  });

  it("read with secrets masked", async () => {
    h.stored = { provider: "resend", apiKey: "re_live_secret_1234", fromEmail: "ops@example.com" };
    const result = body(await serverFor(admin).get("vardo_get_email_settings")!({}));
    expect(result).toMatchObject({ configured: true, provider: "resend", fromEmail: "ops@example.com" });
    expect(JSON.stringify(result)).not.toContain("re_live_secret");
  });

  it("update only the given fields and keep omitted secrets", async () => {
    h.stored = { provider: "resend", apiKey: "re_live_secret_1234", fromEmail: "ops@example.com" };
    const result = await serverFor(admin).get("vardo_update_email_settings")!({ fromName: "Example Ops" });
    expect(result.isError).toBeUndefined();
    expect(h.saved[0]).toMatchObject({
      provider: "resend",
      apiKey: "re_live_secret_1234",
      fromEmail: "ops@example.com",
      fromName: "Example Ops",
    });
    expect(result.content[0].text).not.toContain("re_live_secret");
  });

  it("write a new secret", async () => {
    h.stored = { provider: "resend", apiKey: "old", fromEmail: "ops@example.com" };
    await serverFor(admin).get("vardo_update_email_settings")!({ provider: "postmark", apiKey: "pm-new" });
    expect(h.saved[0]).toMatchObject({ provider: "postmark", apiKey: "pm-new" });
  });

  it("need a from address before anything is stored", async () => {
    const result = await serverFor(admin).get("vardo_update_email_settings")!({ provider: "resend", apiKey: "k" });
    expect(result.isError).toBe(true);
    expect(h.saved).toHaveLength(0);
  });
});
