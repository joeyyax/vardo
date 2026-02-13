import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectExpenses, projects, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and, gte, lte, sql, isNotNull, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type CategoryBreakdown = {
  category: string;
  amountCents: number;
};

type ProjectBreakdown = {
  id: string;
  name: string;
  clientName: string;
  amountCents: number;
};

type ExpenseReportResponse = {
  totalCents: number;
  billableCents: number;
  nonBillableCents: number;
  byCategory: CategoryBreakdown[];
  byProject: ProjectBreakdown[];
  recoveryRate: number;
};

// GET /api/v1/organizations/[orgId]/reports/expenses
// Returns expense report data with optional date filtering
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse<ExpenseReportResponse | { error: string }>> {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");

    // Build where conditions
    const whereConditions = [eq(projectExpenses.organizationId, orgId)];

    if (from) {
      whereConditions.push(gte(projectExpenses.date, from));
    }
    if (to) {
      whereConditions.push(lte(projectExpenses.date, to));
    }
    if (clientId) {
      const clientProjectIds = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.clientId, clientId));
      whereConditions.push(inArray(projectExpenses.projectId, clientProjectIds));
    }
    if (projectId) {
      whereConditions.push(eq(projectExpenses.projectId, projectId));
    }

    const whereClause = and(...whereConditions);

    // Get totals
    const totalsResult = await db
      .select({
        totalCents: sql<number>`COALESCE(SUM(${projectExpenses.amountCents}), 0)`,
        billableCents: sql<number>`COALESCE(SUM(CASE WHEN ${projectExpenses.isBillable} = true THEN ${projectExpenses.amountCents} ELSE 0 END), 0)`,
      })
      .from(projectExpenses)
      .where(whereClause);

    const totalCents = Number(totalsResult[0]?.totalCents ?? 0);
    const billableCents = Number(totalsResult[0]?.billableCents ?? 0);
    const nonBillableCents = totalCents - billableCents;

    // Group by category
    const categoryResults = await db
      .select({
        category: sql<string>`COALESCE(${projectExpenses.category}, 'Uncategorized')`,
        amountCents: sql<number>`SUM(${projectExpenses.amountCents})`,
      })
      .from(projectExpenses)
      .where(whereClause)
      .groupBy(sql`COALESCE(${projectExpenses.category}, 'Uncategorized')`)
      .orderBy(sql`SUM(${projectExpenses.amountCents}) DESC`);

    const byCategory: CategoryBreakdown[] = categoryResults.map((row) => ({
      category: row.category,
      amountCents: Number(row.amountCents),
    }));

    // Group by project (only expenses with a projectId)
    const projectWhereConditions = [...whereConditions, isNotNull(projectExpenses.projectId)];

    const projectResults = await db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        clientName: clients.name,
        amountCents: sql<number>`SUM(${projectExpenses.amountCents})`,
      })
      .from(projectExpenses)
      .innerJoin(projects, eq(projectExpenses.projectId, projects.id))
      .innerJoin(clients, eq(projects.clientId, clients.id))
      .where(and(...projectWhereConditions))
      .groupBy(projects.id, projects.name, clients.name)
      .orderBy(sql`SUM(${projectExpenses.amountCents}) DESC`)
      .limit(5);

    const byProject: ProjectBreakdown[] = projectResults.map((row) => ({
      id: row.projectId,
      name: row.projectName,
      clientName: row.clientName,
      amountCents: Number(row.amountCents),
    }));

    // Calculate recovery rate
    const recoveryRate = totalCents > 0 ? (billableCents / totalCents) * 100 : 0;

    return NextResponse.json({
      totalCents,
      billableCents,
      nonBillableCents,
      byCategory,
      byProject,
      recoveryRate,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching expense report:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
