import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects, tags } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, asc } from "drizzle-orm";
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

  const orgId = orgData.organization.id;

  const [project, allTags] = await Promise.all([
    db.query.projects.findFirst({
      where: and(
        eq(projects.id, id),
        eq(projects.organizationId, orgId)
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
        projectTags: {
          with: { tag: true },
        },
      },
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
  ]);

  if (!project) {
    notFound();
  }

  return (
    <ProjectDetail
      project={project}
      orgId={orgId}
      userRole={orgData.membership.role}
      allTags={allTags}
    />
  );
}
