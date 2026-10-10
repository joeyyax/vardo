import { redirect } from "next/navigation";
import { getUserOrganizations } from "@/lib/auth/session";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadProjectsPage } from "@/lib/app-services/projects";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { FirstRun } from "./first-run";
import { ProjectsActions } from "./projects-actions";
import { ProjectsView } from "./projects-view";

export default async function ProjectsPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const [organizations, data] = await Promise.all([
    getUserOrganizations(),
    pageData(loadProjectsPage(actor)),
  ]);
  const orgId = actor.org.id;

  return (
    <div className="space-y-6">
      <PageToolbar actions={<ProjectsActions canImportContainers={data.containerImport} />}>
        <div className="flex items-center gap-3">
          <h1 className="type-h1">Projects</h1>
          {data.teamsEnabled && <OrgSwitcher currentOrgId={orgId} organizations={organizations} collapsed={false} />}
        </div>
      </PageToolbar>

      {data.projects.length === 0 && data.apps.length === 0 ? (
        <FirstRun canImportContainers={data.containerImport} />
      ) : (
        <ProjectsView orgId={orgId} apps={data.apps} projects={data.projects} initialDensity={data.density} />
      )}
    </div>
  );
}
