import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readOrgNotificationSettings, updateOrgNotificationSettings } from "@/lib/notifications/preferences";
import { NIGHTLY_TIME } from "@/lib/backups/run-rules";
import { NOTIFICATION_CATEGORY_KEYS } from "@/lib/notifications/registry";
import { SENSITIVITIES } from "@/lib/anomaly/signals";

type RouteParams = { params: Promise<{ orgId: string }> };

const categoryKeys = NOTIFICATION_CATEGORY_KEYS as [string, ...string[]];

const patchSchema = z
  .object({
    categories: z.partialRecord(z.enum(categoryKeys), z.boolean()).optional(),
    nightlyBackupTime: z.string().regex(NIGHTLY_TIME, "Use HH:MM, 24-hour").optional(),
    anomalySensitivity: z.enum(SENSITIVITIES).optional(),
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
