import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recurringTemplates } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; id: string }>;
};

// GET /api/v1/organizations/[orgId]/recurring-templates/[id]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const template = await db.query.recurringTemplates.findFirst({
      where: and(
        eq(recurringTemplates.id, id),
        eq(recurringTemplates.organizationId, orgId),
        eq(recurringTemplates.userId, session.user.id)
      ),
      with: {
        client: true,
        project: true,
        task: true,
      },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching recurring template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/recurring-templates/[id]
// Used for: pause/resume, skip date, update details
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const template = await db.query.recurringTemplates.findFirst({
      where: and(
        eq(recurringTemplates.id, id),
        eq(recurringTemplates.organizationId, orgId),
        eq(recurringTemplates.userId, session.user.id)
      ),
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const body = await request.json();
    const updates: Partial<typeof recurringTemplates.$inferInsert> = {};

    // Handle pause/resume
    if (body.isPaused !== undefined) {
      updates.isPaused = body.isPaused;
    }

    // Handle skip date (add to skippedDates array)
    if (body.skipDate) {
      const currentSkipped = template.skippedDates || [];
      if (!currentSkipped.includes(body.skipDate)) {
        updates.skippedDates = [...currentSkipped, body.skipDate];
      }
    }

    // Handle unskip date (remove from skippedDates array)
    if (body.unskipDate) {
      const currentSkipped = template.skippedDates || [];
      updates.skippedDates = currentSkipped.filter((d) => d !== body.unskipDate);
    }

    // Allow updating other fields
    if (body.description !== undefined) updates.description = body.description;
    if (body.durationMinutes !== undefined) updates.durationMinutes = body.durationMinutes;
    if (body.frequency !== undefined) updates.frequency = body.frequency;
    if (body.dayOfWeek !== undefined) updates.dayOfWeek = body.dayOfWeek;
    if (body.dayOfMonth !== undefined) updates.dayOfMonth = body.dayOfMonth;

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(recurringTemplates)
      .set(updates)
      .where(eq(recurringTemplates.id, id))
      .returning();

    // Fetch with relations
    const result = await db.query.recurringTemplates.findFirst({
      where: eq(recurringTemplates.id, updated.id),
      with: {
        client: true,
        project: true,
        task: true,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating recurring template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/recurring-templates/[id]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const template = await db.query.recurringTemplates.findFirst({
      where: and(
        eq(recurringTemplates.id, id),
        eq(recurringTemplates.organizationId, orgId),
        eq(recurringTemplates.userId, session.user.id)
      ),
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    await db.delete(recurringTemplates).where(eq(recurringTemplates.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting recurring template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
