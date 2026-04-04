import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { digestSettings, notificationChannels, organizations } from "@/lib/db/schema";
import { requireOrgAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { collectDigestData } from "@/lib/digest/collector";
import { createChannel } from "@/lib/notifications/factory";
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

// GET /api/v1/organizations/[orgId]/digest
// Returns the digest settings for the org, creating defaults if missing.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const setting = await db.query.digestSettings.findFirst({
      where: eq(digestSettings.organizationId, orgId),
    });

    if (!setting) {
      // Return defaults without persisting — settings are created on first PATCH
      return NextResponse.json({
        digestSettings: {
          enabled: false,
          dayOfWeek: 1,
          hourOfDay: 8,
          lastSentAt: null,
        },
      });
    }

    return NextResponse.json({
      digestSettings: {
        enabled: setting.enabled,
        dayOfWeek: setting.dayOfWeek,
        hourOfDay: setting.hourOfDay,
        lastSentAt: setting.lastSentAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching digest settings");
  }
}

// PATCH /api/v1/organizations/[orgId]/digest
// Creates or updates digest settings for the org.
async function handlePatch(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const now = new Date();

    // Upsert — eliminates the read-then-write race condition
    const [upserted] = await db
      .insert(digestSettings)
      .values({
        id: nanoid(),
        organizationId: orgId,
        enabled: parsed.data.enabled ?? false,
        dayOfWeek: parsed.data.dayOfWeek ?? 1,
        hourOfDay: parsed.data.hourOfDay ?? 8,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: digestSettings.organizationId,
        set: {
          ...(parsed.data.enabled !== undefined && { enabled: parsed.data.enabled }),
          ...(parsed.data.dayOfWeek !== undefined && { dayOfWeek: parsed.data.dayOfWeek }),
          ...(parsed.data.hourOfDay !== undefined && { hourOfDay: parsed.data.hourOfDay }),
          updatedAt: now,
        },
      })
      .returning();

    return NextResponse.json({
      digestSettings: {
        enabled: upserted.enabled,
        dayOfWeek: upserted.dayOfWeek,
        hourOfDay: upserted.hourOfDay,
        lastSentAt: upserted.lastSentAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error updating digest settings");
  }
}

// POST /api/v1/organizations/[orgId]/digest
// Trigger an immediate on-demand digest send for the org.
// Requires admin or owner role. Returns the collected digest data as a preview.
async function handlePost(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    requireOrgAdmin(org.membership.role);

    const orgRecord = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { id: true, name: true },
    });

    if (!orgRecord) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const data = await collectDigestData(orgRecord.id, orgRecord.name);

    const event = {
      type: "digest.weekly" as const,
      title: `Weekly Digest — ${orgRecord.name}`,
      message: `Weekly health summary for ${orgRecord.name}: ${data.deploys.total} deploys, ${data.deploys.failed} failures.`,
      orgName: orgRecord.name,
      weekLabel: data.weekLabel,
      deploysTotal: data.deploys.total,
      deploysSucceeded: data.deploys.succeeded,
      deploysFailed: data.deploys.failed,
      backupsTotal: data.backups.total,
      backupsFailed: data.backups.failed,
      cronTotal: data.cron.totalFailures,
      cronFailed: data.cron.totalFailures,
    };

    // Send synchronously so the caller gets an accurate result
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
