import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, desc, and, gte, lte } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/expenses
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Get optional filters
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const category = searchParams.get("category");

    const whereConditions = [eq(projectExpenses.projectId, projectId)];

    if (startDate) {
      whereConditions.push(gte(projectExpenses.date, startDate));
    }
    if (endDate) {
      whereConditions.push(lte(projectExpenses.date, endDate));
    }
    if (category) {
      whereConditions.push(eq(projectExpenses.category, category));
    }

    const expenses = await db.query.projectExpenses.findMany({
      where: and(...whereConditions),
      orderBy: [desc(projectExpenses.date), desc(projectExpenses.createdAt)],
      with: {
        receiptFile: {
          columns: {
            id: true,
            name: true,
            mimeType: true,
          },
        },
        createdByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Get summary stats
    const allExpenses = await db.query.projectExpenses.findMany({
      where: eq(projectExpenses.projectId, projectId),
    });

    const totalCents = allExpenses.reduce((sum, e) => sum + e.amountCents, 0);
    const billableCents = allExpenses
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.amountCents, 0);

    // Get unique categories
    const categories = [...new Set(allExpenses.map((e) => e.category).filter(Boolean))].sort();

    return NextResponse.json({
      expenses,
      summary: {
        totalCents,
        billableCents,
        nonBillableCents: totalCents - billableCents,
        count: allExpenses.length,
      },
      categories,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expenses:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/expenses
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { description, amountCents, date, category, isBillable, receiptFileId } = body;

    // Validate required fields
    if (!description || typeof description !== "string" || !description.trim()) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }
    if (typeof amountCents !== "number" || amountCents <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 });
    }
    if (!date || typeof date !== "string") {
      return NextResponse.json({ error: "Date is required" }, { status: 400 });
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
    }

    const [expense] = await db
      .insert(projectExpenses)
      .values({
        organizationId: orgId,
        projectId,
        description: description.trim(),
        amountCents: Math.round(amountCents), // Ensure integer
        date,
        category: category?.trim() || null,
        isBillable: isBillable === true,
        receiptFileId: receiptFileId || null,
        createdBy: session.user.id,
      })
      .returning();

    return NextResponse.json(expense, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating expense:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
