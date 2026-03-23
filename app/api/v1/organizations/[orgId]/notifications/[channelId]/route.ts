import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { maskChannelConfig } from "@/lib/notifications/mask-config";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };
const updateSchema = z.object({ name: z.string().min(1).max(100).optional(), config: z.union([z.object({ recipients: z.array(z.string().email()).min(1) }), z.object({ url: z.string().url(), secret: z.string().optional() }), z.object({ webhookUrl: z.string().url() })]).optional(), enabled: z.boolean().optional(), subscribedEvents: z.array(z.string()).optional() });

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const channel = await db.query.notificationChannels.findFirst({ where: and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId)) });
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: maskChannelConfig(channel) });
  } catch (error) { return handleRouteError(error, "Error fetching channel"); }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.config !== undefined) updates.config = parsed.data.config;
    if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
    if (parsed.data.subscribedEvents !== undefined) updates.subscribedEvents = parsed.data.subscribedEvents;
    const [channel] = await db.update(notificationChannels).set(updates).where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId))).returning();
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: maskChannelConfig(channel) });
  } catch (error) { return handleRouteError(error, "Error updating channel"); }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const [deleted] = await db.delete(notificationChannels).where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.organizationId, orgId))).returning({ id: notificationChannels.id });
    if (!deleted) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) { return handleRouteError(error, "Error deleting channel"); }
}
