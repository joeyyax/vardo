import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { eq, asc } from "drizzle-orm";
import { presentChannel } from "@/lib/notifications/channel-config";
import { channelCreateSchema, createChannelRow } from "@/lib/notifications/channels";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string }> };

async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();
    const channels = await db.query.notificationChannels.findMany({ where: eq(notificationChannels.organizationId, orgId), orderBy: [asc(notificationChannels.createdAt)] });
    const masked = channels.map(presentChannel);
    return NextResponse.json({ channels: masked });
  } catch (error) { return handleRouteError(error, "Error fetching notification channels"); }
}

async function handlePost(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const parsed = channelCreateSchema.safeParse(await req.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const channel = await createChannelRow(orgId, parsed.data);
    return NextResponse.json({ channel: presentChannel(channel) }, { status: 201 });
  } catch (error) { return handleRouteError(error, "Error creating notification channel"); }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-notifications" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/notifications" });
