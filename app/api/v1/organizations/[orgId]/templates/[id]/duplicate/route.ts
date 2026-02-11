import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentTemplates } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getStarterTemplate } from "@/lib/template-engine/starter-templates";

type RouteParams = {
  params: Promise<{ orgId: string; id: string }>;
};

// POST /api/v1/organizations/[orgId]/templates/[id]/duplicate
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, id } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Handle duplicating a starter template into the database
    if (id.startsWith("starter:")) {
      const starterId = id.slice("starter:".length);
      const starter = getStarterTemplate(starterId);
      if (!starter) {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }

      const [duplicate] = await db
        .insert(documentTemplates)
        .values({
          organizationId: orgId,
          documentType: starter.documentType,
          name: `${starter.name} (Copy)`,
          displayLabel: starter.displayLabel ?? null,
          description: starter.description,
          category: starter.category,
          sections: starter.sections,
          variableSchema: starter.variableSchema,
          pricingConfig: starter.pricingConfig ?? null,
          sortOrder: starter.sortOrder,
          createdBy: session.user.id,
        })
        .returning();

      return NextResponse.json(duplicate, { status: 201 });
    }

    const source = await db.query.documentTemplates.findFirst({
      where: and(
        eq(documentTemplates.id, id),
        eq(documentTemplates.organizationId, orgId)
      ),
    });

    if (!source) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const [duplicate] = await db
      .insert(documentTemplates)
      .values({
        organizationId: orgId,
        documentType: source.documentType,
        name: `${source.name} (Copy)`,
        displayLabel: source.displayLabel,
        description: source.description,
        category: source.category,
        sections: source.sections,
        variableSchema: source.variableSchema,
        pricingConfig: source.pricingConfig,
        sortOrder: source.sortOrder,
        createdBy: session.user.id,
      })
      .returning();

    return NextResponse.json(duplicate, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error duplicating template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
