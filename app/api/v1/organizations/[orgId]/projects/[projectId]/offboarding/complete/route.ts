import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { sendEmail, getProjectRecipients } from "@/lib/email/send";
import { offboardingCompleteEmail } from "@/lib/email/lifecycle-emails";

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

// POST — mark offboarding complete, advance to completed
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

    if (project.stage !== "offboarding") {
      return NextResponse.json(
        { error: "Project must be in offboarding stage to complete offboarding" },
        { status: 400 }
      );
    }

    // Advance project to completed
    const [updated] = await db
      .update(projects)
      .set({
        stage: "completed",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();

    // Send offboarding-complete email to project recipients
    const recipients = await getProjectRecipients(projectId);
    if (recipients.length > 0) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const emailData = offboardingCompleteEmail({
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
          console.error("Failed to send offboarding complete email:", err)
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
    console.error("Error completing offboarding:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
