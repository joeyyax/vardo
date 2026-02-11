import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentTemplates } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getStarterTemplate } from "@/lib/template-engine/starter-templates";

type RouteParams = {
  params: Promise<{ orgId: string; id: string }>;
};

// GET /api/v1/organizations/[orgId]/templates/[id]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Handle starter template IDs (prefixed with "starter:")
    if (id.startsWith("starter:")) {
      const starterId = id.slice("starter:".length);
      const starter = getStarterTemplate(starterId);
      if (!starter) {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      return NextResponse.json({
        id: `starter:${starter.id}`,
        organizationId: orgId,
        documentType: starter.documentType,
        name: starter.name,
        displayLabel: starter.displayLabel ?? null,
        description: starter.description,
        category: starter.category,
        sections: starter.sections,
        variableSchema: starter.variableSchema,
        pricingConfig: starter.pricingConfig ?? null,
        sortOrder: starter.sortOrder,
        createdBy: null,
        createdAt: null,
        updatedAt: null,
        isStarter: true,
      });
    }

    const template = await db.query.documentTemplates.findFirst({
      where: and(
        eq(documentTemplates.id, id),
        eq(documentTemplates.organizationId, orgId)
      ),
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/templates/[id]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const template = await db.query.documentTemplates.findFirst({
      where: and(
        eq(documentTemplates.id, id),
        eq(documentTemplates.organizationId, orgId)
      ),
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const body = await request.json();
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof body.name === "string" && body.name.trim()) {
      updateData.name = body.name.trim();
    }
    if (body.displayLabel !== undefined) {
      updateData.displayLabel = body.displayLabel?.trim() || null;
    }
    if (body.description !== undefined) {
      updateData.description = body.description?.trim() || null;
    }
    if (body.category !== undefined) {
      updateData.category = body.category?.trim() || null;
    }
    if (body.documentType !== undefined) {
      updateData.documentType = body.documentType;
    }
    if (body.sections !== undefined) {
      updateData.sections = body.sections;
    }
    if (body.variableSchema !== undefined) {
      updateData.variableSchema = body.variableSchema;
    }
    if (body.pricingConfig !== undefined) {
      updateData.pricingConfig = body.pricingConfig;
    }
    if (body.sortOrder !== undefined) {
      updateData.sortOrder = body.sortOrder;
    }

    const [updated] = await db
      .update(documentTemplates)
      .set(updateData)
      .where(eq(documentTemplates.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/templates/[id]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const template = await db.query.documentTemplates.findFirst({
      where: and(
        eq(documentTemplates.id, id),
        eq(documentTemplates.organizationId, orgId)
      ),
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    await db.delete(documentTemplates).where(eq(documentTemplates.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
