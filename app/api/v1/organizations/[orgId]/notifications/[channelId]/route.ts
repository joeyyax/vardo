import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { presentChannel } from "@/lib/notifications/channel-config";
import { channelUpdateSchema, deleteChannelRow, findChannel, updateChannelRow } from "@/lib/notifications/channels";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();
    const channel = await findChannel(orgId, channelId);
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: presentChannel(channel) });
  } catch (error) { return handleRouteError(error, "Error fetching channel"); }
}

async function handlePatch(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const parsed = channelUpdateSchema.safeParse(await req.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const channel = await updateChannelRow(orgId, channelId, parsed.data);
    if (!channel) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ channel: presentChannel(channel) });
  } catch (error) { return handleRouteError(error, "Error updating channel"); }
}

async function handleDelete(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const deleted = await deleteChannelRow(orgId, channelId);
    if (!deleted) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) { return handleRouteError(error, "Error deleting channel"); }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-notifications" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-notifications" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/notifications/*" });
