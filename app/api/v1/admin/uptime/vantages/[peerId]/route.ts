import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requireAdminAuth } from "@/lib/auth/admin";
import { uptimeClient } from "@/lib/uptime/client";
import { linkPatchSchema } from "@/lib/uptime/link";

type RouteParams = { params: Promise<{ peerId: string }> };

// PATCH — switch uptime checks on or off for one mesh link, in either direction
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { peerId } = await params;
    const parsed = linkPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const link = await uptimeClient.setVantageLink(peerId, parsed.data);
    return link ? NextResponse.json({ link }) : apiError.notFound("peer");
  } catch (error) {
    return handleRouteError(error, "Error updating uptime link");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-uptime-vantages" });
