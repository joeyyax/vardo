import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { digestSettings, notificationChannels, organizations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { collectDigestData, digestEvent } from "@/lib/digest/collector";
import { DIGEST_CADENCES, digestWindow, scheduleFor } from "@/lib/digest/window";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import { createChannel } from "@/lib/notifications/factory";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string }> };

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    cadence: z.enum(DIGEST_CADENCES).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    hourOfDay: z.number().int().min(0).max(23).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update",
  });

function view(row: { enabled: boolean; cadence: string; dayOfWeek: number; hourOfDay: number; lastSentAt: Date | null } | undefined) {
  return { ...scheduleFor(row), lastSentAt: row?.lastSentAt?.toISOString() ?? null };
}

// GET /api/v1/organizations/[orgId]/digest
// Returns the org's digest settings, or the defaults.
async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const setting = await db.query.digestSettings.findFirst({
      where: eq(digestSettings.organizationId, orgId),
    });
    return NextResponse.json({ digestSettings: view(setting), timeZone: await getOrgTimeZone(orgId) });
  } catch (error) {
    return handleRouteError(error, "Error fetching digest settings");
  }
}

// PATCH /api/v1/organizations/[orgId]/digest
async function handlePatch(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.digest.manage");
    if (!org) return apiError.forbidden();

    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const now = new Date();
    const [upserted] = await db
      .insert(digestSettings)
      .values({ id: nanoid(), organizationId: orgId, ...parsed.data, updatedAt: now })
      .onConflictDoUpdate({
        target: digestSettings.organizationId,
        set: { ...parsed.data, updatedAt: now },
      })
      .returning();

    return NextResponse.json({ digestSettings: view(upserted) });
  } catch (error) {
    return handleRouteError(error, "Error updating digest settings");
  }
}

// POST /api/v1/organizations/[orgId]/digest
// Sends the last complete window's digest now and returns its data. Admins and owners only.
async function handlePost(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.digest.manage");
    if (!org) return apiError.forbidden();

    const orgRecord = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { id: true, name: true },
    });

    if (!orgRecord) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const setting = await db.query.digestSettings.findFirst({ where: eq(digestSettings.organizationId, orgId) });
    const window = digestWindow(scheduleFor(setting).cadence, new Date(), await getOrgTimeZone(orgId));
    const withHost = (await adminOrgIds()).includes(orgId);
    const data = await collectDigestData(orgRecord.id, orgRecord.name, window, { withHost });
    const event = digestEvent(data);

    const channels = await db.query.notificationChannels.findMany({
      where: and(
        eq(notificationChannels.organizationId, orgId),
        eq(notificationChannels.enabled, true),
      ),
    });

    const results = await Promise.allSettled(
      channels.map((row) => createChannel(row).send(event)),
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    return NextResponse.json({
      digest: data,
      channels: { sent, failed, total: channels.length },
    });
  } catch (error) {
    return handleRouteError(error, "Error sending on-demand digest");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-digest" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-digest" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/digest" });
