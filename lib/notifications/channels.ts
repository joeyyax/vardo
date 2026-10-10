import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { isMaskedValue, restoreMaskedConfig } from "./mask-config";
import { openChannelConfig, sealChannelConfig } from "./channel-config";

// Creating and updating notification channels, shared by the REST routes and MCP tools.

export const CHANNEL_TYPES = ["email", "webhook", "slack"] as const;

const CONFIG_KEY: Record<(typeof CHANNEL_TYPES)[number], string> = {
  email: "recipients",
  webhook: "url",
  slack: "webhookUrl",
};

const urlOrMask = z.string().url().or(z.string().refine(isMaskedValue));

export const channelCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(CHANNEL_TYPES),
    config: z.union([
      z.object({ recipients: z.array(z.string().email()).min(1) }),
      z.object({ url: z.string().url(), secret: z.string().optional() }),
      z.object({ webhookUrl: z.string().url() }),
    ]),
    enabled: z.boolean().optional().default(true),
    subscribedEvents: z.array(z.string()).optional().default([]),
  })
  .strict()
  .refine((d) => CONFIG_KEY[d.type] in d.config, {
    message: "Config doesn't match the channel type: email takes recipients, webhook takes url, slack takes webhookUrl",
    path: ["config"],
  });

export const channelUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    config: z
      .union([
        z.object({ recipients: z.array(z.string().email()).min(1) }),
        z.object({ url: urlOrMask, secret: z.string().optional() }),
        z.object({ webhookUrl: urlOrMask }),
      ])
      .optional(),
    enabled: z.boolean().optional(),
    subscribedEvents: z.array(z.string()).optional(),
  })
  .strict();

export type ChannelCreate = z.infer<typeof channelCreateSchema>;
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;

const channelWhere = (orgId: string, channelId: string) =>
  and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId));

export async function createChannelRow(orgId: string, input: ChannelCreate) {
  const [channel] = await db
    .insert(notificationChannels)
    .values({
      id: nanoid(),
      organizationId: orgId,
      name: input.name,
      type: input.type,
      config: sealChannelConfig(input.config, orgId),
      enabled: input.enabled,
      subscribedEvents: input.subscribedEvents,
    })
    .returning();
  return channel;
}

/** The updated row, or null when the channel isn't in the org. A masked URL or secret keeps the stored one. */
export async function updateChannelRow(orgId: string, channelId: string, input: ChannelUpdate) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) {
    const stored = await db.query.notificationChannels.findFirst({ where: channelWhere(orgId, channelId) });
    if (!stored) return null;
    const config = restoreMaskedConfig(input.config, openChannelConfig(stored));
    updates.config = sealChannelConfig(config, orgId);
  }
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.subscribedEvents !== undefined) updates.subscribedEvents = input.subscribedEvents;
  const [channel] = await db.update(notificationChannels).set(updates).where(channelWhere(orgId, channelId)).returning();
  return channel ?? null;
}

/** The deleted channel's id, or null when it isn't in the org. */
export async function deleteChannelRow(orgId: string, channelId: string): Promise<string | null> {
  const [deleted] = await db
    .delete(notificationChannels)
    .where(channelWhere(orgId, channelId))
    .returning({ id: notificationChannels.id });
  return deleted?.id ?? null;
}

export function findChannel(orgId: string, channelId: string) {
  return db.query.notificationChannels.findFirst({ where: channelWhere(orgId, channelId) });
}
