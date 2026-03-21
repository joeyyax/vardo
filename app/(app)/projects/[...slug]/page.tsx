import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects, tags, orgEnvVars, environments } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, asc, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ProjectDetail } from "./project-detail";

const VALID_TABS = ["projects", "deployments", "connect", "variables", "networking", "logs", "volumes", "cron", "terminal", "metrics"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug: string[] }>;
};

export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug } = await params;

  // URL patterns:
  //   /projects/{slug}
  //   /projects/{slug}/{tab}
  //   /projects/{slug}/{tab}/{subView}
  //   /projects/{slug}/{env}
  //   /projects/{slug}/{env}/{tab}
  //   /projects/{slug}/{env}/{tab}/{subView}
  // Disambiguate: if segment 2 is a known tab, it's a tab. Otherwise it's an env name.
  const projectSlug = slug[0];
  let envSegment: string | undefined;
  let tabSegment: string | undefined;
  let subSegment: string | undefined;

  if (slug.length >= 2) {
    if (VALID_TABS.includes(slug[1] as ValidTab)) {
      // /projects/{slug}/{tab}/...
      tabSegment = slug[1];
      subSegment = slug[2];
    } else {
      // /projects/{slug}/{env}/...
      envSegment = slug[1];
      if (slug.length >= 3) {
        if (VALID_TABS.includes(slug[2] as ValidTab)) {
          tabSegment = slug[2];
          subSegment = slug[3];
        } else {
          notFound();
        }
      }
    }
  }

  const tab: ValidTab | undefined = tabSegment && VALID_TABS.includes(tabSegment as ValidTab)
    ? (tabSegment as ValidTab)
    : undefined;

  // If there's a tab segment that doesn't match, or too many segments, 404
  if (tabSegment && !tab) {
    notFound();
  }
  if (slug.length > 4) {
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
    parent: {
      columns: { id: true, name: true, color: true },
    },
    children: {
      columns: { id: true, name: true, displayName: true, status: true, imageName: true, gitUrl: true, deployType: true },
      orderBy: (c: any, { asc }: any) => [asc(c.sortOrder)],
      with: {
        domains: { columns: { domain: true, isPrimary: true }, limit: 1 },
      },
    },
  } as const;

  // Look up by name (slug) or ID — supports clean URLs like /projects/redis
  const [project, allTags, allProjects, orgVars] = await Promise.all([
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
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, color: true, parentId: true },
    }),
    db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
      columns: { key: true },
    }),
  ]);

  if (!project) {
    notFound();
  }

  // Backfill: ensure production environment exists (safe to remove after all projects have been visited)
  if (!project.environments.some((e) => e.type === "production")) {
    const [created] = await db
      .insert(environments)
      .values({
        id: nanoid(),
        projectId: project.id,
        name: "production",
        type: "production",
        isDefault: true,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      project.environments.unshift(created);
    }
  }

  // Validate environment segment against actual environments
  if (envSegment && !project.environments.some((e) => e.name === envSegment)) {
    notFound();
  }

  // Strip "production" from URL — it's the default, no need to spell it out
  if (envSegment === "production") {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/projects/${project.name}${tabPath}`);
  }

  // If accessed by ID, redirect to the clean slug URL
  if (projectSlug === project.id && projectSlug !== project.name) {
    const envPath = envSegment ? `/${envSegment}` : "";
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/projects/${project.name}${envPath}${tabPath}`);
  }

  // Load sibling projects if this project has a parent
  let siblings: { name: string; displayName: string; status: string }[] = [];
  if (project.parentId) {
    const siblingList = await db.query.projects.findMany({
      where: and(
        eq(projects.organizationId, orgId),
        eq(projects.parentId, project.parentId),
      ),
      columns: { name: true, displayName: true, status: true },
    });
    siblings = siblingList.filter((s) => s.name !== project.name);
  }

  // Build parent projects list (projects that have children or could be parents)
  const allParentProjects = allProjects
    .filter((p) => !p.parentId && p.id !== project.id)
    .map((p) => ({ id: p.id, name: p.name, color: p.color || "#6366f1" }));

  return (
    <ProjectDetail
      project={project}
      orgId={orgId}
      userRole={orgData.membership.role}
      allTags={allTags}
      allParentProjects={allParentProjects}
      allProjectNames={allProjects.map((p) => p.name)}
      orgVarKeys={orgVars.map((v) => v.key)}
      siblings={siblings}
      initialTab={tab || (project.children && project.children.length > 0 ? "projects" : "deployments")}
      initialEnv={envSegment}
      initialSubView={subSegment}
    />
  );
}
