import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { eq, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { presentChannel, sealChannelConfig } from "@/lib/notifications/channel-config";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string }> };
const createSchema = z.object({ name: z.string().min(1).max(100), type: z.enum(["email", "webhook", "slack"]), config: z.union([z.object({ recipients: z.array(z.string().email()).min(1) }), z.object({ url: z.string().url(), secret: z.string().optional() }), z.object({ webhookUrl: z.string().url() })]), enabled: z.boolean().optional().default(true), subscribedEvents: z.array(z.string()).optional().default([]) }).strict();

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const channels = await db.query.notificationChannels.findMany({ where: eq(notificationChannels.organizationId, orgId), orderBy: [asc(notificationChannels.createdAt)] });
    const masked = channels.map(presentChannel);
    return NextResponse.json({ channels: masked });
  } catch (error) { return handleRouteError(error, "Error fetching notification channels"); }
}

async function handlePost(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    const [channel] = await db.insert(notificationChannels).values({ id: nanoid(), organizationId: orgId, name: parsed.data.name, type: parsed.data.type, config: sealChannelConfig(parsed.data.config, orgId), enabled: parsed.data.enabled, subscribedEvents: parsed.data.subscribedEvents }).returning();
    return NextResponse.json({ channel: presentChannel(channel) }, { status: 201 });
  } catch (error) { return handleRouteError(error, "Error creating notification channel"); }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-notifications" });
