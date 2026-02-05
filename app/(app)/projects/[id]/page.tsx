import { redirect, notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ProjectDashboard } from "./project-dashboard";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProjectPage({ params }: PageProps) {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { id } = await params;

  // Fetch project with client and tasks
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, id),
    with: {
      client: true,
      tasks: {
        where: eq(tasks.isArchived, false),
        orderBy: (tasks, { asc }) => [asc(tasks.name)],
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
    />
  );
}
