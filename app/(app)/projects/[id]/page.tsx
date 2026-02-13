import { redirect, notFound } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { projects, tasks, DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ProjectDashboard } from "./project-dashboard";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);

  if (!orgData || !session?.user?.id) {
    redirect("/onboarding");
  }

  const { id } = await params;

  // Merge org features with defaults
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(orgData.organization.features as OrgFeatures | null),
  };

  // Check if time_tracking OR pm feature is enabled
  if (!features.time_tracking && !features.pm) {
    redirect("/settings");
  }

  // Fetch project with client and tasks
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, id),
    with: {
      client: true,
      tasks: {
        where: eq(tasks.isArchived, false),
        orderBy: (tasks, { asc }) => [asc(tasks.name)],
        with: {
          type: {
            columns: { id: true, name: true, color: true, icon: true },
          },
          assignedToUser: {
            columns: { id: true, name: true, email: true },
          },
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  // Verify project belongs to user's org
  if (project.client.organizationId !== orgData.organization.id) {
    notFound();
  }

  return (
    <ProjectDashboard
      project={project}
      orgId={orgData.organization.id}
      orgName={orgData.organization.name}
      pmEnabled={features.pm}
      currentUserId={session.user.id}
      isAdmin={isAdminRole(orgData.membership.role)}
    />
  );
}
