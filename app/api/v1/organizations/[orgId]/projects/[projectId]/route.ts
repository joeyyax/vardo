import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, clients, timeEntries, PROJECT_STAGES, VALID_STAGE_TRANSITIONS, BUDGET_TYPES, type ProjectStage, type BudgetType } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { sendEmail, getProjectRecipients } from "@/lib/email/send";
import { offboardingStartedEmail } from "@/lib/email/lifecycle-emails";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// Helper to verify project belongs to org
async function getProjectForOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: {
        columns: {
          id: true,
          name: true,
          color: true,
          contactEmail: true,
          organizationId: true,
        },
      },
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await getProjectForOrg(projectId, orgId);

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Remove organizationId from client before returning
    const { organizationId: _orgId, ...clientWithoutOrgId } = project.client;
    void _orgId; // Suppress unused variable warning
    return NextResponse.json({
      ...project,
      client: clientWithoutOrgId,
    });
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
    console.error("Error fetching project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project exists and belongs to this org
    const existingProject = await getProjectForOrg(projectId, orgId);

    if (!existingProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { clientId, name, code, rateOverride, isBillable, isArchived, stage, budgetType, budgetHours, budgetAmountCents } = body;

    // Build update object with only provided fields
    const updates: Partial<{
      clientId: string;
      name: string;
      code: string | null;
      rateOverride: number | null;
      isBillable: boolean | null;
      isArchived: boolean;
      stage: ProjectStage;
      budgetType: BudgetType | null;
      budgetHours: number | null;
      budgetAmountCents: number | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    // If changing client, verify new client belongs to this org
    if (clientId !== undefined && clientId !== existingProject.clientId) {
      const newClient = await db.query.clients.findFirst({
        where: and(
          eq(clients.id, clientId),
          eq(clients.organizationId, orgId)
        ),
      });

      if (!newClient) {
        return NextResponse.json(
          { error: "Client not found" },
          { status: 404 }
        );
      }
      updates.clientId = clientId;
    }

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return NextResponse.json(
          { error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updates.name = name.trim();
    }

    if (code !== undefined) {
      updates.code = code?.trim() || null;
    }

    if (rateOverride !== undefined) {
      updates.rateOverride =
        rateOverride !== null && rateOverride !== "" && rateOverride !== undefined
          ? Math.round(parseFloat(rateOverride) * 100)
          : null;
    }

    if (isBillable !== undefined) {
      updates.isBillable = isBillable;
    }

    if (isArchived !== undefined) {
      updates.isArchived = isArchived;
    }

    if (stage !== undefined) {
      if (stage !== null && !PROJECT_STAGES.includes(stage)) {
        return NextResponse.json(
          { error: `Stage must be one of: ${PROJECT_STAGES.join(", ")}` },
          { status: 400 }
        );
      }

      // Validate stage transition
      const currentStage = existingProject.stage || "getting_started";
      if (stage && stage !== currentStage) {
        const allowed = VALID_STAGE_TRANSITIONS[currentStage as ProjectStage] || [];
        if (!allowed.includes(stage as ProjectStage)) {
          return NextResponse.json(
            { error: `Cannot transition from "${currentStage}" to "${stage}". Valid transitions: ${allowed.join(", ") || "none (terminal state)"}` },
            { status: 400 }
          );
        }
      }

      updates.stage = stage;
    }

    if (budgetType !== undefined) {
      if (budgetType !== null && !BUDGET_TYPES.includes(budgetType)) {
        return NextResponse.json(
          { error: `Budget type must be one of: ${BUDGET_TYPES.join(", ")}` },
          { status: 400 }
        );
      }
      updates.budgetType = budgetType;
    }

    if (budgetHours !== undefined) {
      updates.budgetHours = budgetHours !== null && budgetHours !== "" ? Number(budgetHours) : null;
    }

    if (budgetAmountCents !== undefined) {
      updates.budgetAmountCents = budgetAmountCents !== null && budgetAmountCents !== "" ? Number(budgetAmountCents) : null;
    }

    await db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, projectId));

    // Send offboarding notification email when stage changes to offboarding
    if (updates.stage === "offboarding") {
      const recipients = await getProjectRecipients(projectId);
      if (recipients.length > 0) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        const emailData = offboardingStartedEmail({
          organizationName: organization.name,
          clientName: existingProject.client.name,
          projectName: existingProject.name,
          workspaceUrl: baseUrl,
        });

        for (const recipient of recipients) {
          sendEmail(
            {
              to: recipient,
              subject: emailData.subject,
              react: emailData.react,
              from: `${organization.name} <${process.env.EMAIL_FROM || "notifications@joeyyax.com"}>`,
            },
            {
              organizationId: orgId,
              entityType: "lifecycle",
              entityId: projectId,
            }
          ).catch((err) =>
            console.error("Failed to send offboarding email:", err)
          );
        }
      }
    }

    // If project moved to a different client, update all entries for this project
    if (updates.clientId) {
      await db
        .update(timeEntries)
        .set({ clientId: updates.clientId })
        .where(eq(timeEntries.projectId, projectId));
    }

    // Fetch updated project with client info
    const updatedProject = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
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

    return NextResponse.json(updatedProject);
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
    console.error("Error updating project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project exists and belongs to this org
    const existingProject = await getProjectForOrg(projectId, orgId);

    if (!existingProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await db.delete(projects).where(eq(projects.id, projectId));

    return NextResponse.json({ success: true });
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
    console.error("Error deleting project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
