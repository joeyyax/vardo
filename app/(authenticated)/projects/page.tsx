import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { loadProjectsApps } from "@/lib/projects/load-apps";
import { getCurrentOrg, getSession, getUserOrganizations } from "@/lib/auth/session";
import { canImportContainers } from "@/lib/auth/admin";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { getUserPreferences, DEFAULT_PREFERENCES } from "@/lib/user/preferences";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { FirstRun } from "./first-run";
import { ProjectsActions } from "./projects-actions";
import { ProjectsView } from "./projects-view";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const orgId = orgData.organization.id;
  const session = await getSession();

  const [organizations, shaped, projectList, containerImportEnabled, teamsEnabled, prefs] = await Promise.all([
    getUserOrganizations(),
    loadProjectsApps(orgId),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, displayName: true, isSystemManaged: true },
    }),
    canImportContainers(),
    isFeatureEnabledAsync("teams"),
    session?.user?.id ? getUserPreferences(session.user.id) : Promise.resolve(DEFAULT_PREFERENCES),
  ]);

  return (
    <div className="space-y-6">
      <PageToolbar actions={<ProjectsActions canImportContainers={containerImportEnabled} />}>
        <div className="flex items-center gap-3">
          <h1 className="type-h1">Projects</h1>
          {teamsEnabled && <OrgSwitcher currentOrgId={orgId} organizations={organizations} collapsed={false} />}
        </div>
      </PageToolbar>

      {projectList.length === 0 && shaped.length === 0 ? (
        <FirstRun canImportContainers={containerImportEnabled} />
      ) : (
        <ProjectsView orgId={orgId} apps={shaped} projects={projectList} initialDensity={prefs.density} />
      )}
    </div>
  );
}
