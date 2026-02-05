import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, clients, timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, inArray, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type BudgetStatus = "on_budget" | "at_risk" | "over_budget";

type ProjectWithBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  budgetType: string;
  budgetValue: number;
  usedValue: number;
  usedPercentage: number;
  status: BudgetStatus;
};

type ProjectWithoutBudget = {
  id: string;
  name: string;
  clientName: string;
  clientColor: string | null;
  totalMinutes: number;
};

type ProjectHealthResponse = {
  activeCount: number;
  onBudgetCount: number;
  atRiskCount: number;
  overBudgetCount: number;
  projectsWithBudgets: ProjectWithBudget[];
  projectsWithoutBudgets: ProjectWithoutBudget[];
};

function getStatusFromPercentage(percentage: number): BudgetStatus {
  if (percentage > 100) return "over_budget";
  if (percentage >= 80) return "at_risk";
  return "on_budget";
}

function getStatusSortOrder(status: BudgetStatus): number {
  switch (status) {
    case "over_budget":
      return 0;
    case "at_risk":
      return 1;
    case "on_budget":
      return 2;
  }
}

// GET /api/v1/organizations/[orgId]/reports/projects
// Returns project budget health data
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse<ProjectHealthResponse | { error: string }>> {
  const { orgId } = await params;

  let organization;
  try {
    const result = await requireOrg();
    organization = result.organization;
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    throw error;
  }

  if (organization.id !== orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get org's clients
  const orgClients = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.organizationId, orgId));

  // Handle empty case
  if (orgClients.length === 0) {
    return NextResponse.json({
      activeCount: 0,
      onBudgetCount: 0,
      atRiskCount: 0,
      overBudgetCount: 0,
      projectsWithBudgets: [],
      projectsWithoutBudgets: [],
    });
  }

  const clientIds = orgClients.map((c) => c.id);

  // Get active projects with client info
  const activeProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      budgetType: projects.budgetType,
      budgetHours: projects.budgetHours,
      budgetAmountCents: projects.budgetAmountCents,
      clientName: clients.name,
      clientColor: clients.color,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(
      and(inArray(projects.clientId, clientIds), eq(projects.isArchived, false))
    );

  // Handle empty projects
  if (activeProjects.length === 0) {
    return NextResponse.json({
      activeCount: 0,
      onBudgetCount: 0,
      atRiskCount: 0,
      overBudgetCount: 0,
      projectsWithBudgets: [],
      projectsWithoutBudgets: [],
    });
  }

  const projectIds = activeProjects.map((p) => p.id);

  // Get time totals per project
  const timeTotals = await db
    .select({
      projectId: timeEntries.projectId,
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
    })
    .from(timeEntries)
    .where(inArray(timeEntries.projectId, projectIds))
    .groupBy(timeEntries.projectId);

  // Build a map for quick lookup
  const minutesByProject = new Map<string, number>();
  for (const row of timeTotals) {
    if (row.projectId) {
      minutesByProject.set(row.projectId, Number(row.totalMinutes));
    }
  }

  // Classify projects
  const projectsWithBudgets: ProjectWithBudget[] = [];
  const projectsWithoutBudgets: ProjectWithoutBudget[] = [];

  // Get org default rate for fixed budget calculation
  const defaultRate = organization.defaultRate ?? 0;

  for (const project of activeProjects) {
    const totalMinutes = minutesByProject.get(project.id) ?? 0;
    const hasBudget =
      project.budgetType &&
      (project.budgetHours !== null || project.budgetAmountCents !== null);

    if (hasBudget) {
      let budgetValue: number;
      let usedValue: number;

      if (project.budgetType === "hours") {
        budgetValue = project.budgetHours ?? 0;
        usedValue = totalMinutes / 60;
      } else {
        // fixed budget
        budgetValue = project.budgetAmountCents ?? 0;
        usedValue = (totalMinutes / 60) * defaultRate;
      }

      const usedPercentage =
        budgetValue > 0 ? (usedValue / budgetValue) * 100 : 0;
      const status = getStatusFromPercentage(usedPercentage);

      projectsWithBudgets.push({
        id: project.id,
        name: project.name,
        clientName: project.clientName,
        clientColor: project.clientColor,
        budgetType: project.budgetType!,
        budgetValue,
        usedValue,
        usedPercentage,
        status,
      });
    } else {
      projectsWithoutBudgets.push({
        id: project.id,
        name: project.name,
        clientName: project.clientName,
        clientColor: project.clientColor,
        totalMinutes,
      });
    }
  }

  // Sort projects with budgets by status (over_budget first, then at_risk, then on_budget)
  projectsWithBudgets.sort(
    (a, b) => getStatusSortOrder(a.status) - getStatusSortOrder(b.status)
  );

  // Count statuses
  let onBudgetCount = 0;
  let atRiskCount = 0;
  let overBudgetCount = 0;

  for (const project of projectsWithBudgets) {
    switch (project.status) {
      case "on_budget":
        onBudgetCount++;
        break;
      case "at_risk":
        atRiskCount++;
        break;
      case "over_budget":
        overBudgetCount++;
        break;
    }
  }

  return NextResponse.json({
    activeCount: activeProjects.length,
    onBudgetCount,
    atRiskCount,
    overBudgetCount,
    projectsWithBudgets,
    projectsWithoutBudgets,
  });
}
