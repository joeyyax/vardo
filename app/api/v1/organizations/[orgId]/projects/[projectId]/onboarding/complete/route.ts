import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, onboardingItems } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { sendEmail, getProjectRecipients } from "@/lib/email/send";
import { onboardingCompleteEmail } from "@/lib/email/lifecycle-emails";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

async function verifyProjectAccess(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: { columns: { organizationId: true, name: true } },
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

// POST — mark onboarding complete, advance to active
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.stage !== "onboarding") {
      return NextResponse.json(
        { error: "Project must be in onboarding stage to complete onboarding" },
        { status: 400 }
      );
    }

    // Check all required items are completed
    const items = await db.query.onboardingItems.findMany({
      where: eq(onboardingItems.projectId, projectId),
    });

    const incompleteRequired = items.filter(
      (item) => item.isRequired && !item.isCompleted
    );

    if (incompleteRequired.length > 0) {
      return NextResponse.json(
        {
          error: "All required checklist items must be completed before advancing",
          incompleteItems: incompleteRequired.map((i) => i.label),
        },
        { status: 400 }
      );
    }

    // Advance project to active
    const [updated] = await db
      .update(projects)
      .set({
        stage: "active",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();

    // Send onboarding-complete email to project recipients
    const recipients = await getProjectRecipients(projectId);
    if (recipients.length > 0) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const emailData = onboardingCompleteEmail({
        organizationName: organization.name,
        clientName: project.client.name,
        projectName: project.name,
        workspaceUrl: baseUrl,
      });

      for (const recipient of recipients) {
        sendEmail(
          {
            to: recipient,
            subject: emailData.subject,
            react: emailData.react,
            from: `${organization.name} <${process.env.EMAIL_FROM || "noreply@usescope.net"}>`,
          },
          {
            organizationId: orgId,
            entityType: "lifecycle",
            entityId: projectId,
          }
        ).catch((err) =>
          console.error("Failed to send onboarding complete email:", err)
        );
      }
    }

    return NextResponse.json({
      success: true,
      project: updated,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error completing onboarding:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
