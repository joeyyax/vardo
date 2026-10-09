import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { digestSettings, notificationChannels, organizations } from "@/lib/db/schema";
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
// Returns the org's digest settings, or unsaved defaults.
async function handleGet(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const setting = await db.query.digestSettings.findFirst({
      where: eq(digestSettings.organizationId, orgId),
    });

    if (!setting) {
      // Settings are persisted on the first PATCH.
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
// Sends a digest now and returns its data as a preview. Admins and owners only.
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
      backupsSucceeded: data.backups.succeeded,
      cronAffectedJobs: data.cron.affectedJobs,
      diskWriteAlerts: data.alerts.diskWriteAlerts,
      volumeDrifts: data.alerts.volumeDrifts,
      projects: data.projects,
      deploysByDay: data.deploysByDay,
    };

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
