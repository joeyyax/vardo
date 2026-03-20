import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects, tags, groups, orgEnvVars } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, asc, or } from "drizzle-orm";
import { ProjectDetail } from "./project-detail";

const VALID_TABS = ["deployments", "connect", "variables", "networking", "logs", "volumes", "cron", "terminal", "metrics", "environments"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug: string[] }>;
};

export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const [projectSlug, tabSegment, subSegment] = slug;

  // Validate tab segment if present
  const tab: ValidTab | undefined = tabSegment && VALID_TABS.includes(tabSegment as ValidTab)
    ? (tabSegment as ValidTab)
    : undefined;

  // If there's an invalid second segment, 404
  if (tabSegment && !tab) {
    notFound();
  }

  // If there are more than 3 segments, 404
  if (slug.length > 3) {
    notFound();
  }

  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const projectWith = {
    deployments: {
      orderBy: (d: any, { desc }: any) => [desc(d.startedAt)],
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
    group: true,
  } as const;

  // Look up by name (slug) or ID — supports clean URLs like /projects/redis
  const [project, allTags, allGroups, allProjects, orgVars] = await Promise.all([
    db.query.projects.findFirst({
      where: and(
        eq(projects.organizationId, orgId),
        or(eq(projects.name, projectSlug), eq(projects.id, projectSlug)),
      ),
      with: projectWith,
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
    db.query.groups.findMany({
      where: eq(groups.organizationId, orgId),
      orderBy: [asc(groups.name)],
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

  // If accessed by ID, redirect to the clean slug URL
  if (projectSlug === project.id && projectSlug !== project.name) {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/projects/${project.name}${tabPath}`);
  }

  // Load sibling projects if this project is in a group
  let groupSiblings: { name: string; displayName: string; status: string }[] = [];
  if (project.groupId) {
    const siblings = await db.query.projects.findMany({
      where: and(
        eq(projects.organizationId, orgId),
        eq(projects.groupId, project.groupId),
      ),
      columns: { name: true, displayName: true, status: true },
    });
    groupSiblings = siblings.filter((s) => s.name !== project.name);
  }

  return (
    <ProjectDetail
      project={project}
      orgId={orgId}
      userRole={orgData.membership.role}
      allTags={allTags}
      allGroups={allGroups}
      allProjectNames={allProjects.map((p) => p.name)}
      orgVarKeys={orgVars.map((v) => v.key)}
      groupSiblings={groupSiblings}
      initialTab={tab || "deployments"}
      initialSubView={subSegment}
    />
  );
}
