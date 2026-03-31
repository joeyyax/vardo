import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { projects, projectInstances } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, or, desc, type AnyColumn } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { isAdmin } from "@/lib/auth/permissions";
import { ProjectDetail } from "./project-detail";
import type { MeshPeerSummary, ProjectInstanceSummary } from "@/lib/mesh/types";

const VALID_TABS = ["apps", "deployments", "variables", "logs", "metrics", "backups", "instances"] as const;
type ValidTab = (typeof VALID_TABS)[number];

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const projectSlug = slug[0];

  // URL patterns:
  //   /projects/{slug}
  //   /projects/{slug}/{tab}
  let tabSegment: string | undefined;

  if (slug.length === 2) {
    if (VALID_TABS.includes(slug[1] as ValidTab)) {
      tabSegment = slug[1];
    } else {
      notFound();
    }
  } else if (slug.length > 2) {
    notFound();
  }

  const tab: ValidTab | undefined = tabSegment as ValidTab | undefined;

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");
  const orgId = orgData.organization.id;
  const userIsAdmin = isAdmin(orgData.membership.role);

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.organizationId, orgId),
      or(eq(projects.name, projectSlug), eq(projects.id, projectSlug)),
    ),
    with: {
      apps: {
        columns: {
          id: true,
          name: true,
          displayName: true,
          description: true,
          status: true,
          needsRedeploy: true,
          imageName: true,
          gitUrl: true,
          gitBranch: true,
          deployType: true,
          source: true,
          dependsOn: true,
          parentAppId: true,
          composeService: true,
          containerName: true,
          isSystemManaged: true,
        },
        with: {
          domains: { columns: { domain: true, isPrimary: true } },
          deployments: {
            columns: {
              id: true,
              status: true,
              trigger: true,
              gitSha: true,
              gitMessage: true,
              durationMs: true,
              log: true,
              startedAt: true,
              finishedAt: true,
            },
            orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
            limit: 10,
            with: {
              triggeredByUser: {
                columns: { id: true, name: true, image: true },
              },
            },
          },
          envVars: {
            columns: { id: true, key: true, value: true, isSecret: true, createdAt: true, updatedAt: true },
          },
          childApps: {
            columns: {
              id: true,
              name: true,
              displayName: true,
              composeService: true,
              status: true,
              containerName: true,
              imageName: true,
              dependsOn: true,
              cpuLimit: true,
              memoryLimit: true,
              persistentVolumes: true,
            },
          },
        },
      },
      groupEnvironments: true,
    },
  });

  if (!project) notFound();

  // Redirect ID-based URLs to clean slug
  if (projectSlug === project.id && projectSlug !== project.name) {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/projects/${project.name}${tabPath}`);
  }

  const effectiveTab = tab || "apps";

  // Fetch mesh flag + data in parallel
  const [meshEnabled, meshPeers, meshInstances] = await Promise.all([
    isFeatureEnabledAsync("mesh"),
    // Peers are system-level (not org-scoped) — all peers visible to admins
    db.query.meshPeers.findMany({
      columns: { id: true, name: true, type: true, status: true, connectionType: true },
    }).then((p) => p as MeshPeerSummary[]).catch(() => [] as MeshPeerSummary[]),
    db.query.projectInstances.findMany({
      where: eq(projectInstances.projectId, project.id),
      columns: { id: true, environment: true, gitRef: true, status: true, meshPeerId: true, transferredAt: true },
    }).then((i) => i as ProjectInstanceSummary[]).catch(() => [] as ProjectInstanceSummary[]),
  ]);

  return (
    <ProjectDetail
      project={project}
      orgId={orgId}
      initialTab={effectiveTab}
      isAdmin={userIsAdmin}
      meshEnabled={meshEnabled}
      meshPeers={meshEnabled ? meshPeers : []}
      projectInstances={meshEnabled ? meshInstances : []}
    />
  );
}
