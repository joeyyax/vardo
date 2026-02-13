import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reportConfigs } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; configId: string }>;
};

// GET /api/v1/organizations/[orgId]/reports/[configId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, configId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const config = await db.query.reportConfigs.findFirst({
      where: and(
        eq(reportConfigs.id, configId),
        eq(reportConfigs.organizationId, orgId)
      ),
      with: {
        client: true,
        project: true,
      },
    });

    if (!config) {
      return NextResponse.json({ error: "Report config not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: config.id,
      slug: config.slug,
      enabled: config.enabled,
      showRates: config.showRates,
      autoSend: config.autoSend,
      autoSendDay: config.autoSendDay,
      autoSendHour: config.autoSendHour,
      recipients: config.recipients,
      clientId: config.clientId,
      projectId: config.projectId,
      client: config.client
        ? { id: config.client.id, name: config.client.name, color: config.client.color }
        : null,
      project: config.project
        ? { id: config.project.id, name: config.project.name }
        : null,
      createdAt: config.createdAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error fetching report config:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/reports/[configId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, configId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    // Verify config exists
    const existing = await db.query.reportConfigs.findFirst({
      where: and(
        eq(reportConfigs.id, configId),
        eq(reportConfigs.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Report config not found" }, { status: 404 });
    }

    const body = await request.json();
    const updateData: Record<string, unknown> = {};

    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.showRates !== undefined) updateData.showRates = body.showRates;
    if (body.autoSend !== undefined) updateData.autoSend = body.autoSend;
    if (body.autoSendDay !== undefined) updateData.autoSendDay = body.autoSendDay;
    if (body.autoSendHour !== undefined) updateData.autoSendHour = body.autoSendHour;
    if (body.recipients !== undefined) updateData.recipients = body.recipients;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const [updated] = await db
      .update(reportConfigs)
      .set(updateData)
      .where(eq(reportConfigs.id, configId))
      .returning();

    return NextResponse.json({
      id: updated.id,
      slug: updated.slug,
      enabled: updated.enabled,
      showRates: updated.showRates,
      autoSend: updated.autoSend,
      autoSendDay: updated.autoSendDay,
      autoSendHour: updated.autoSendHour,
      recipients: updated.recipients,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error updating report config:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/reports/[configId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, configId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    // Verify config exists
    const existing = await db.query.reportConfigs.findFirst({
      where: and(
        eq(reportConfigs.id, configId),
        eq(reportConfigs.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Report config not found" }, { status: 404 });
    }

    await db.delete(reportConfigs).where(eq(reportConfigs.id, configId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error deleting report config:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
