import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { digestSettings, notificationChannels, organizations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { collectDigestData } from "@/lib/digest/collector";
import { createChannel } from "@/lib/notifications/factory";

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
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
export async function POST(_req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { id: true, name: true },
    });

    if (!org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const data = await collectDigestData(org.id, org.name);

    const event = {
      type: "weekly-digest" as const,
      title: `Weekly Digest — ${org.name}`,
      message: `Weekly health summary for ${org.name}: ${data.deploys.total} deploys, ${data.deploys.failed} failures.`,
      metadata: {
        orgName: org.name,
        weekLabel: data.weekLabel,
        deploysTotal: String(data.deploys.total),
        deploysSucceeded: String(data.deploys.succeeded),
        deploysFailed: String(data.deploys.failed),
        backupsTotal: String(data.backups.total),
        backupsSucceeded: String(data.backups.succeeded),
        backupsFailed: String(data.backups.failed),
        cronFailures: String(data.cron.totalFailures),
        cronAffectedJobs: JSON.stringify(data.cron.affectedJobs),
        diskWriteAlerts: String(data.alerts.diskWriteAlerts),
        volumeDrifts: String(data.alerts.volumeDrifts),
        projects: JSON.stringify(data.projects),
      },
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
