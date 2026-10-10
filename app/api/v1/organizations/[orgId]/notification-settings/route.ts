import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  MAX_BATCH_WINDOW_MINUTES,
  MIN_BATCH_WINDOW_MINUTES,
  readOrgNotificationSettings,
  updateOrgNotificationSettings,
} from "@/lib/notifications/preferences";
import { NOTIFICATION_CATEGORY_KEYS } from "@/lib/notifications/registry";

type RouteParams = { params: Promise<{ orgId: string }> };

const categoryKeys = NOTIFICATION_CATEGORY_KEYS as [string, ...string[]];

const patchSchema = z
  .object({
    categories: z.partialRecord(z.enum(categoryKeys), z.boolean()).optional(),
    batchWindowMinutes: z.number().int().min(MIN_BATCH_WINDOW_MINUTES).max(MAX_BATCH_WINDOW_MINUTES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

// GET /api/v1/organizations/[orgId]/notification-settings
async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();
    return NextResponse.json({ settings: await readOrgNotificationSettings(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error fetching notification settings");
  }
}

// PATCH /api/v1/organizations/[orgId]/notification-settings
async function handlePatch(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.notifications.manage");
    if (!org) return apiError.forbidden();
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    return NextResponse.json({ settings: await updateOrgNotificationSettings(orgId, parsed.data) });
  } catch (error) {
    return handleRouteError(error, "Error updating notification settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/notification-settings" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-notification-settings" });
