import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, or } from "drizzle-orm";
import { ProjectDetail } from "./project-detail";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const projectSlug = slug[0];

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");
  const orgId = orgData.organization.id;

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.organizationId, orgId),
      or(eq(projects.name, projectSlug), eq(projects.id, projectSlug)),
    ),
    with: {
      apps: {
        with: {
          domains: { columns: { domain: true, isPrimary: true } },
          deployments: {
            columns: {
              id: true,
              status: true,
              startedAt: true,
              finishedAt: true,
            },
            orderBy: (d: any, { desc }: any) => [desc(d.startedAt)],
            limit: 1,
          },
        },
      },
      groupEnvironments: true,
    },
  });

  if (!project) notFound();

  // Redirect ID-based URLs to clean slug
  if (projectSlug === project.id && projectSlug !== project.name) {
    redirect(`/projects/${project.name}`);
  }

  return <ProjectDetail project={project} orgId={orgId} />;
}
