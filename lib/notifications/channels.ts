import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { notificationChannels, projects } from "@/lib/db/schema";
import { restoreMaskedConfig } from "./mask-config";
import { openChannelConfig, sealChannelConfig } from "./channel-config";
import { CHANNEL_TYPES } from "./channel-types";
import { parseChannelConfig } from "./channel-schemas";

// Creating and updating notification channels, shared by the REST routes and MCP tools.

export { CHANNEL_TYPES };

/** A config the channel's type rejects, or a project outside the org. */
export class ChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConfigError";
  }
}

const configInput = z.record(z.string(), z.unknown());
const projectIdsInput = z.array(z.string().min(1)).max(500).transform((ids) => [...new Set(ids)]);

export const channelCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(CHANNEL_TYPES),
    config: configInput,
    enabled: z.boolean().optional().default(true),
    subscribedEvents: z.array(z.string()).optional().default([]),
    projectIds: projectIdsInput.optional().default([]),
  })
  .strict()
  .transform((d, ctx) => {
    const parsed = parseChannelConfig(d.type, d.config);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error, path: ["config"] });
      return z.NEVER;
    }
    return { ...d, config: parsed.config };
  });

/** A config is checked against the stored channel's type when applied. */
export const channelUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    config: configInput.optional(),
    enabled: z.boolean().optional(),
    subscribedEvents: z.array(z.string()).optional(),
    projectIds: projectIdsInput.optional(),
  })
  .strict();

export type ChannelCreate = z.infer<typeof channelCreateSchema>;
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;

const channelWhere = (orgId: string, channelId: string) =>
  and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId));

/** Throws ChannelConfigError when a project isn't in the org. */
async function assertOrgProjects(orgId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const found = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.organizationId, orgId), inArray(projects.id, projectIds)));
  const known = new Set(found.map((p) => p.id));
  const missing = projectIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new ChannelConfigError(`Project not found: ${missing.join(", ")}`);
}

/** Throws ChannelConfigError when a project isn't in the org. */
export async function createChannelRow(orgId: string, input: ChannelCreate) {
  await assertOrgProjects(orgId, input.projectIds);
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
      projectIds: input.projectIds,
    })
    .returning();
  return channel;
}

/** The updated row, or null when the channel isn't in the org. A masked URL or secret keeps the stored one. Throws ChannelConfigError when the type rejects the config or a project isn't in the org. */
export async function updateChannelRow(orgId: string, channelId: string, input: ChannelUpdate) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) {
    const stored = await db.query.notificationChannels.findFirst({ where: channelWhere(orgId, channelId) });
    if (!stored) return null;
    const merged = restoreMaskedConfig(input.config, openChannelConfig(stored));
    const parsed = parseChannelConfig(stored.type, merged);
    if (!parsed.ok) throw new ChannelConfigError(parsed.error);
    updates.config = sealChannelConfig(parsed.config, orgId);
  }
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.subscribedEvents !== undefined) updates.subscribedEvents = input.subscribedEvents;
  if (input.projectIds !== undefined) {
    await assertOrgProjects(orgId, input.projectIds);
    updates.projectIds = input.projectIds;
  }
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
