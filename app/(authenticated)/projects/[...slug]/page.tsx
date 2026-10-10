import { redirect, notFound } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadProjectDetail } from "@/lib/app-services/projects";
import { ProjectDetail } from "./project-detail";

const VALID_TABS = ["apps", "deployments", "variables", "settings", "logs", "metrics", "backups", "instances"] as const;
type ValidTab = (typeof VALID_TABS)[number];

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const projectSlug = slug[0];

  // /projects/{slug}[/{tab}]
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

  const actor = await currentActor();
  if (!actor) redirect("/login");

  const data = await pageData(loadProjectDetail(actor, projectSlug));
  const { project } = data;

  // Redirect ID-based URLs to clean slug
  if (projectSlug === project.id && projectSlug !== project.name) {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/projects/${project.name}${tabPath}`);
  }

  // Requesting a tab gated by a disabled flag falls back to apps
  const effectiveTab = tab === "logs" && !data.loggingEnabled ? "apps" : tab || "apps";

  return (
    <ProjectDetail
      project={project}
      orgId={actor.org.id}
      initialTab={effectiveTab}
      canDelete={data.canDelete}
      canImportContainers={data.containerImport}
      isInstanceAdmin={data.instanceAdmin}
      meshEnabled={data.meshEnabled}
      loggingEnabled={data.loggingEnabled}
      environmentsEnabled={data.environmentsEnabled}
      meshPeers={data.meshPeers}
      projectInstances={data.projectInstances}
      listApps={data.listApps}
      density={data.density}
    />
  );
}
