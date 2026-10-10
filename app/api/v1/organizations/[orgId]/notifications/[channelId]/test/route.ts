import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { findChannel } from "@/lib/notifications/channels";
import { sendTestNotification } from "@/lib/notifications/test-send";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string; channelId: string }> };

// POST /api/v1/organizations/[orgId]/notifications/[channelId]/test — send a test notification and report the provider's answer.
async function handlePost(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, channelId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const channel = await findChannel(orgId, channelId);
    if (!channel) return apiError.notFound("channel");
    const result = await sendTestNotification(channel);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) { return handleRouteError(error, "Error sending test notification"); }
}

export const POST = withRateLimit(handlePost, { tier: "heavy", key: "organizations-notifications-test" });
