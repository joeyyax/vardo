import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { ProjectDetail } from "./project-detail";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ProjectDetailPage({ params }: PageProps) {
  const { id } = await params;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, id),
      eq(projects.organizationId, orgData.organization.id)
    ),
    with: {
      deployments: {
        orderBy: (d, { desc }) => [desc(d.startedAt)],
        limit: 10,
      },
      domains: true,
      environments: true,
      envVars: {
        columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
      },
    },
  });

  if (!project) {
    notFound();
  }

  return (
    <ProjectDetail
      project={project}
      orgId={orgData.organization.id}
      userRole={orgData.membership.role}
    />
  );
}
