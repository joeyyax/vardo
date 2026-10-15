import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadProjectsPage } from "@/lib/app-services/projects";
import { PageToolbar } from "@/components/page-toolbar";
import { FirstRun } from "./first-run";
import { ProjectsActions } from "./projects-actions";
import { ProjectsView } from "./projects-view";

export default async function ProjectsPage() {
  const actor = await currentActor();
  if (!actor) redirect("/login");

  const data = await pageData(loadProjectsPage(actor));
  const orgId = actor.org.id;

  return (
    <div className="space-y-6">
      <PageToolbar actions={<ProjectsActions canImportContainers={data.containerImport} />}>
        <h1 className="type-h1">Projects</h1>
      </PageToolbar>

      {data.projects.length === 0 && data.apps.length === 0 ? (
        <FirstRun canImportContainers={data.containerImport} />
      ) : (
        <ProjectsView
          orgId={orgId}
          instanceAdmin={actor.instanceAdmin}
          apps={data.apps}
          projects={data.projects}
          initialDensity={data.density}
          initialSort={data.sort}
          initialStars={data.stars}
        />
      )}
    </div>
  );
}
