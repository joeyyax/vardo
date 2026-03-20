import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects, tags, orgEnvVars } from "@/lib/db/schema";
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

  const [project, allTags, allProjects, orgVars] = await Promise.all([
    db.query.projects.findFirst({
      where: and(
        eq(projects.id, id),
        eq(projects.organizationId, orgId)
      ),
      with: {
        deployments: {
          orderBy: (d, { desc }) => [desc(d.startedAt)],
          limit: 10,
          with: {
            triggeredByUser: {
              columns: { id: true, name: true, image: true },
            },
          },
        },
        domains: true,
        environments: true,
        envVars: {
          columns: { id: true, key: true, value: true, isSecret: true, createdAt: true, updatedAt: true },
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
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { name: true },
    }),
    db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
      columns: { key: true },
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
      allProjectNames={allProjects.map((p) => p.name)}
      orgVarKeys={orgVars.map((v) => v.key)}
    />
  );
}
