import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { presentChannel } from "@/lib/notifications/channel-config";
import {
  CHANNEL_TYPES,
  ChannelConfigError,
  channelCreateSchema,
  channelUpdateSchema,
  createChannelRow,
  deleteChannelRow,
  updateChannelRow,
} from "@/lib/notifications/channels";
import { sendTestNotification } from "@/lib/notifications/test-send";
import { ALL_EVENT_TYPES } from "@/lib/bus/events";
import type { McpAuthContext } from "../auth";
import { accessDenied, accessibleOrgIds, canAccessOrg, orgFilter, resolveTargetOrg } from "../scope";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

const configInput = z
  .object({
    recipients: z.array(z.string()).optional().describe("email: addresses to send to"),
    url: z.string().optional().describe("webhook: the URL Vardo POSTs JSON to"),
    secret: z.string().optional().describe("webhook: HMAC secret for the X-Signature-256 header"),
    webhookUrl: z.string().optional().describe("slack: the incoming webhook URL. discord: the https://discord.com/api/webhooks/... URL"),
    serverUrl: z.string().optional().describe("ntfy: server URL, default https://ntfy.sh"),
    topic: z.string().optional().describe("ntfy: topic to publish to"),
    accessToken: z.string().optional().describe("ntfy: access token, instead of username and password"),
    username: z.string().optional().describe("ntfy: basic auth username"),
    password: z.string().optional().describe("ntfy: basic auth password"),
    markdown: z.boolean().optional().describe("ntfy: send Markdown, default true; turn off for servers older than 2.7"),
    botToken: z.string().optional().describe("telegram: bot token from BotFather"),
    chatId: z.string().optional().describe("telegram: chat ID or @channelname"),
    userKey: z.string().optional().describe("pushover: user key"),
    appToken: z.string().optional().describe("pushover: application API token"),
  })
  .describe(
    "email takes recipients; webhook takes url and an optional secret; slack and discord take webhookUrl; ntfy takes topic plus optional serverUrl, accessToken or username and password, markdown; telegram takes botToken and chatId; pushover takes userKey and appToken. Stored URLs, tokens and secrets come back masked as ****; send a masked value back to keep the stored one.",
  );

const eventsInput = z
  .array(z.string())
  .describe(`Event types the channel receives; empty means all. Known types: ${ALL_EVENT_TYPES.join(", ")}`);

const findChannel = (channelId: string) =>
  db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, channelId) });

export function registerNotificationChannelTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_notification_channels",
    "List notification channels (email, webhook, Slack, ntfy, Discord, Telegram, Pushover) with their type, enabled flag, subscribed events and config. URLs, tokens and secrets are masked.",
    {
      channelId: z.string().optional().describe("Only this channel"),
    },
    async ({ channelId }) => {
      const orgIds = await accessibleOrgIds(context, "org.view");
      const rows = await db.query.notificationChannels.findMany({
        where: orgFilter(notificationChannels.organizationId, orgIds),
        orderBy: [asc(notificationChannels.createdAt)],
      });
      const channels = (channelId ? rows.filter((c) => c.id === channelId) : rows).map(presentChannel);
      if (channelId && channels.length === 0) return accessDenied("Notification channel");
      return text({ channels });
    },
  );

  server.tool(
    "vardo_create_notification_channel",
    "Create a notification channel. Use vardo_test_notification_channel afterwards to check it delivers.",
    {
      organizationId: z.string().optional().describe("Defaults to the token's org"),
      name: z.string().describe("Channel name"),
      type: z.enum(CHANNEL_TYPES),
      config: configInput,
      enabled: z.boolean().optional().describe("Default true"),
      subscribedEvents: eventsInput.optional(),
    },
    async ({ organizationId, ...input }) => {
      const orgId = await resolveTargetOrg(context, organizationId, "org.notifications.manage");
      if (!orgId) return accessDenied("Organization");
      const parsed = channelCreateSchema.safeParse(input);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
      const channel = await createChannelRow(orgId, parsed.data);
      return text({ channel: presentChannel(channel) });
    },
  );

  server.tool(
    "vardo_update_notification_channel",
    "Update a notification channel's name, config, enabled flag or subscribed events. The config replaces the stored one, except masked values, which keep what's stored.",
    {
      channelId: z.string().describe("The channel ID"),
      name: z.string().optional(),
      config: configInput.optional(),
      enabled: z.boolean().optional(),
      subscribedEvents: eventsInput.optional(),
    },
    async ({ channelId, ...input }) => {
      const channel = await findChannel(channelId);
      if (!channel || !(await canAccessOrg(context, channel.organizationId, "org.notifications.manage"))) {
        return accessDenied("Notification channel");
      }
      const parsed = channelUpdateSchema.safeParse(input);
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid input");
      let updated;
      try {
        updated = await updateChannelRow(channel.organizationId, channel.id, parsed.data);
      } catch (err) {
        if (err instanceof ChannelConfigError) return failure(err.message);
        throw err;
      }
      if (!updated) return accessDenied("Notification channel");
      return text({ channel: presentChannel(updated) });
    },
  );

  server.tool(
    "vardo_delete_notification_channel",
    "Delete a notification channel.",
    {
      channelId: z.string().describe("The channel ID"),
    },
    async ({ channelId }) => {
      const channel = await findChannel(channelId);
      if (!channel || !(await canAccessOrg(context, channel.organizationId, "org.notifications.manage"))) {
        return accessDenied("Notification channel");
      }
      await deleteChannelRow(channel.organizationId, channel.id);
      return text({ deleted: channel.id });
    },
  );

  server.tool(
    "vardo_test_notification_channel",
    "Send a test notification, labeled as a test, through one channel, enabled or not. Reports whether the provider accepted it, with the HTTP status for every type except email and the provider message ID where it returns one.",
    {
      channelId: z.string().describe("The channel ID"),
    },
    async ({ channelId }) => {
      const channel = await findChannel(channelId);
      if (!channel || !(await canAccessOrg(context, channel.organizationId, "org.notifications.manage"))) {
        return accessDenied("Notification channel");
      }
      const result = await sendTestNotification(channel);
      return result.ok ? text(result) : { ...text(result), isError: true as const };
    },
  );
}
