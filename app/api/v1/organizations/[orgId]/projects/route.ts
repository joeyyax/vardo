import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, clients, PROJECT_STAGES, BUDGET_TYPES, type ProjectStage, type BudgetType } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const includeArchived = searchParams.get("includeArchived") === "true";
    const includeTasks = searchParams.get("includeTasks") === "true";

    // Get all clients for this org to filter projects
    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      columns: { id: true },
    });
    const orgClientIds = orgClients.map((c) => c.id);

    // Build query - fetch projects with their client info and optionally tasks
    const orgProjects = await db.query.projects.findMany({
      with: {
        client: {
          columns: {
            id: true,
            name: true,
            color: true,
          },
        },
        ...(includeTasks
          ? {
              tasks: {
                where: (tasks, { eq }) =>
                  includeArchived ? undefined : eq(tasks.isArchived, false),
                orderBy: (tasks, { asc }) => [asc(tasks.name)],
              },
            }
          : {}),
      },
      where: (projects, { and, eq, inArray }) => {
        const conditions = [];

        // Only get projects for clients in this org
        if (orgClientIds.length === 0) {
          // No clients, return empty
          return eq(projects.id, "00000000-0000-0000-0000-000000000000");
        }
        conditions.push(inArray(projects.clientId, orgClientIds));

        // Filter by specific client if provided
        if (clientId) {
          conditions.push(eq(projects.clientId, clientId));
        }

        // Filter out archived unless explicitly included
        if (!includeArchived) {
          conditions.push(eq(projects.isArchived, false));
        }

        return conditions.length > 0 ? and(...conditions) : undefined;
      },
      orderBy: (projects, { asc }) => [asc(projects.name)],
    });

    return NextResponse.json(orgProjects);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching projects:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/projects
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { clientId, name, code, rateOverride, isBillable, stage, budgetType, budgetHours, budgetAmountCents } = body;

    // Validate required fields
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    if (!clientId) {
      return NextResponse.json(
        { error: "Client is required" },
        { status: 400 }
      );
    }

    // Verify the client belongs to this organization
    const client = await db.query.clients.findFirst({
      where: and(
        eq(clients.id, clientId),
        eq(clients.organizationId, orgId)
      ),
    });

    if (!client) {
      return NextResponse.json(
        { error: "Client not found" },
        { status: 404 }
      );
    }

    // Convert rate from dollars to cents if provided
    const rateInCents =
      rateOverride !== null && rateOverride !== undefined && rateOverride !== ""
        ? Math.round(parseFloat(rateOverride) * 100)
        : null;

    // Validate stage if provided
    const projectStage: ProjectStage | undefined = stage && PROJECT_STAGES.includes(stage) ? stage : undefined;

    // Validate budget type if provided
    const projectBudgetType: BudgetType | null = budgetType && BUDGET_TYPES.includes(budgetType) ? budgetType : null;

    const [newProject] = await db
      .insert(projects)
      .values({
        clientId,
        name: name.trim(),
        code: code?.trim() || null,
        rateOverride: rateInCents,
        isBillable: isBillable ?? null,
        stage: projectStage,
        budgetType: projectBudgetType,
        budgetHours: budgetHours ? Number(budgetHours) : null,
        budgetAmountCents: budgetAmountCents ? Number(budgetAmountCents) : null,
      })
      .returning();

    // Fetch the project with client info
    const projectWithClient = await db.query.projects.findFirst({
      where: eq(projects.id, newProject.id),
      with: {
        client: {
          columns: {
            id: true,
            name: true,
            color: true,
          },
        },
      },
    });

    return NextResponse.json(projectWithClient, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error creating project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
