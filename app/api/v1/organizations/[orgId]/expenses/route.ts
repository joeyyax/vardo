import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects } from "@/lib/db/schema";
import { requireOrg, getSession } from "@/lib/auth/session";
import { eq, and, desc, gte, lte, isNull } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/expenses
// List all expenses in the organization (both project-specific and overhead)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get optional filters
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const category = searchParams.get("category");
    const projectId = searchParams.get("projectId");
    const billableOnly = searchParams.get("billable") === "true";
    const overheadOnly = searchParams.get("overhead") === "true";
    const recurringOnly = searchParams.get("recurring") === "true";

    // Build where conditions - always filter by org
    const whereConditions = [eq(projectExpenses.organizationId, orgId)];

    if (startDate) {
      whereConditions.push(gte(projectExpenses.date, startDate));
    }
    if (endDate) {
      whereConditions.push(lte(projectExpenses.date, endDate));
    }
    if (category) {
      whereConditions.push(eq(projectExpenses.category, category));
    }
    if (billableOnly) {
      whereConditions.push(eq(projectExpenses.isBillable, true));
    }
    if (overheadOnly) {
      // Only show expenses without a project (general business expenses)
      whereConditions.push(isNull(projectExpenses.projectId));
    } else if (projectId) {
      // Filter to specific project
      whereConditions.push(eq(projectExpenses.projectId, projectId));
    }
    if (recurringOnly) {
      whereConditions.push(eq(projectExpenses.isRecurring, true));
    }

    const expenses = await db.query.projectExpenses.findMany({
      where: and(...whereConditions),
      orderBy: [desc(projectExpenses.date), desc(projectExpenses.createdAt)],
      with: {
        project: {
          columns: {
            id: true,
            name: true,
          },
          with: {
            client: {
              columns: {
                id: true,
                name: true,
                color: true,
              },
            },
          },
        },
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

    // Get all expenses for summary (unfiltered by date/category but filtered by org)
    const allExpenses = await db.query.projectExpenses.findMany({
      where: eq(projectExpenses.organizationId, orgId),
      columns: {
        amountCents: true,
        isBillable: true,
        category: true,
        projectId: true,
      },
    });

    const totalCents = allExpenses.reduce((sum, e) => sum + e.amountCents, 0);
    const billableCents = allExpenses
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.amountCents, 0);
    const overheadCents = allExpenses
      .filter((e) => !e.projectId)
      .reduce((sum, e) => sum + e.amountCents, 0);

    // Get unique categories
    const categories = [...new Set(allExpenses.map((e) => e.category).filter(Boolean))].sort();

    return NextResponse.json({
      expenses,
      summary: {
        totalCents,
        billableCents,
        nonBillableCents: totalCents - billableCents,
        overheadCents,
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

// POST /api/v1/organizations/[orgId]/expenses
// Create a new expense (project is optional)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      projectId, // Optional - null means overhead/general expense
      description,
      amountCents,
      date,
      category,
      isBillable,
      receiptFileId,
      isRecurring,
      recurringFrequency,
      nextOccurrence,
      recurringEndDate,
    } = body;

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

    // If projectId is provided, verify it belongs to this org
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: {
          client: {
            columns: { organizationId: true },
          },
        },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
    }

    const [expense] = await db
      .insert(projectExpenses)
      .values({
        organizationId: orgId,
        projectId: projectId || null,
        description: description.trim(),
        amountCents: Math.round(amountCents),
        date,
        category: category?.trim() || null,
        isBillable: isBillable === true,
        receiptFileId: receiptFileId || null,
        isRecurring: isRecurring === true,
        recurringFrequency: isRecurring ? recurringFrequency : null,
        nextOccurrence: isRecurring ? nextOccurrence : null,
        recurringEndDate: recurringEndDate || null,
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
