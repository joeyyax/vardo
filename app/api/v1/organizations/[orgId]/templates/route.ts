import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documentTemplates } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";
import { ALL_STARTER_TEMPLATES } from "@/lib/template-engine/starter-templates";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/templates
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const documentType = searchParams.get("documentType");
    const category = searchParams.get("category");

    // Fetch custom (org-created) templates from the database
    const conditions = [eq(documentTemplates.organizationId, orgId)];

    if (documentType) {
      conditions.push(eq(documentTemplates.documentType, documentType as "proposal" | "contract" | "change_order" | "orientation" | "addendum"));
    }
    if (category) {
      conditions.push(eq(documentTemplates.category, category));
    }

    const customTemplates = await db.query.documentTemplates.findMany({
      where: and(...conditions),
      orderBy: [desc(documentTemplates.sortOrder)],
    });

    // Build starter templates matching the same shape, filtered by query params
    let starters = ALL_STARTER_TEMPLATES;
    if (documentType) {
      starters = starters.filter((t) => t.documentType === documentType);
    }
    if (category) {
      starters = starters.filter((t) => t.category === category);
    }

    const starterTemplateRows = starters.map((t) => ({
      id: `starter:${t.id}`,
      organizationId: orgId,
      documentType: t.documentType,
      name: t.name,
      displayLabel: t.displayLabel ?? null,
      description: t.description,
      category: t.category,
      sections: t.sections,
      variableSchema: t.variableSchema,
      pricingConfig: t.pricingConfig ?? null,
      sortOrder: t.sortOrder,
      createdBy: null,
      createdAt: null,
      updatedAt: null,
      isStarter: true,
    }));

    // Custom templates first, then starters
    const allTemplates = [
      ...customTemplates.map((t) => ({ ...t, isStarter: false })),
      ...starterTemplateRows,
    ];

    return NextResponse.json(allTemplates);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching templates:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/templates
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { documentType, name, displayLabel, description, category, sections, variableSchema, pricingConfig, sortOrder } = body;

    if (!documentType || !name?.trim()) {
      return NextResponse.json(
        { error: "documentType and name are required" },
        { status: 400 }
      );
    }

    const [template] = await db
      .insert(documentTemplates)
      .values({
        organizationId: orgId,
        documentType,
        name: name.trim(),
        displayLabel: displayLabel?.trim() || null,
        description: description?.trim() || null,
        category: category?.trim() || null,
        sections: sections || [],
        variableSchema: variableSchema || [],
        pricingConfig: pricingConfig || null,
        sortOrder: sortOrder ?? 0,
        createdBy: session.user.id,
      })
      .returning();

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
