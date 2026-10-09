import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { openChannelConfig, presentChannel, sealChannelConfig } from "@/lib/notifications/channel-config";
import { isMaskedValue, restoreMaskedConfig } from "@/lib/notifications/mask-config";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };
const urlOrMask = z.string().url().or(z.string().refine(isMaskedValue));
const updateSchema = z.object({ name: z.string().min(1).max(100).optional(), config: z.union([z.object({ recipients: z.array(z.string().email()).min(1) }), z.object({ url: urlOrMask, secret: z.string().optional() }), z.object({ webhookUrl: urlOrMask })]).optional(), enabled: z.boolean().optional(), subscribedEvents: z.array(z.string()).optional() }).strict();

async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();
    const channel = await db.query.notificationChannels.findFirst({ where: and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId)) });
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: presentChannel(channel) });
  } catch (error) { return handleRouteError(error, "Error fetching channel"); }
}

async function handlePatch(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.config !== undefined) {
      const stored = await db.query.notificationChannels.findFirst({ where: and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId)) });
      if (!stored) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
      const config = restoreMaskedConfig(parsed.data.config, openChannelConfig(stored));
      updates.config = sealChannelConfig(config, orgId);
    }
    if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
    if (parsed.data.subscribedEvents !== undefined) updates.subscribedEvents = parsed.data.subscribedEvents;
    const [channel] = await db.update(notificationChannels).set(updates).where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId))).returning();
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: presentChannel(channel) });
  } catch (error) { return handleRouteError(error, "Error updating channel"); }
}

async function handleDelete(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const [deleted] = await db.delete(notificationChannels).where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId))).returning({ id: notificationChannels.id });
    if (!deleted) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) { return handleRouteError(error, "Error deleting channel"); }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-notifications" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-notifications" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/notifications/*" });
