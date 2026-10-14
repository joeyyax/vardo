import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { digestSettings, organizations, user, userDigestPreferences } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { collectDigestData } from "@/lib/digest/collector";
import { deliverDigests } from "@/lib/digest/tick";
import { digestWindow, frequencyFor, scheduleFor } from "@/lib/digest/window";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = { params: Promise<{ orgId: string }> };

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    hourOfDay: z.number().int().min(0).max(23).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "No fields to update",
  });

function view(row: { enabled: boolean; dayOfWeek: number; hourOfDay: number; lastSentAt: Date | null } | undefined) {
  return { ...scheduleFor(row), lastSentAt: row?.lastSentAt?.toISOString() ?? null };
}

// GET /api/v1/organizations/[orgId]/digest
// Returns when the org's digests go out, or the defaults.
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
// Emails the caller the last complete window at their frequency, weekly when theirs is off. Admins and owners only.
async function handlePost(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.digest.manage");
    if (!org) return apiError.forbidden();
    const userId = org.session.user.id;

    const [orgRecord, me, pref] = await Promise.all([
      db.query.organizations.findFirst({ where: eq(organizations.id, orgId), columns: { id: true, name: true } }),
      db.query.user.findFirst({ where: eq(user.id, userId), columns: { email: true } }),
      db.query.userDigestPreferences.findFirst({
        where: and(eq(userDigestPreferences.userId, userId), eq(userDigestPreferences.organizationId, orgId)),
        columns: { frequency: true },
      }),
    ]);
    if (!orgRecord) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }
    if (!me) return apiError.forbidden();

    const frequency = frequencyFor(pref);
    const window = digestWindow(frequency === "off" ? "weekly" : frequency, new Date(), await getOrgTimeZone(orgId));
    const withHost = (await adminOrgIds()).includes(orgId);
    const data = await collectDigestData(orgRecord.id, orgRecord.name, window, { withHost });
    const sent = await deliverDigests(orgId, window, data, [{ userId, email: me.email }]);

    return NextResponse.json({ digest: data, sent: sent > 0 });
  } catch (error) {
    return handleRouteError(error, "Error sending on-demand digest");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-digest" });
export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-digest" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/digest" });
