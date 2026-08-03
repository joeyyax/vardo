import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { getInstanceConfig } from "@/lib/system-settings";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { NewAppFlow } from "./new-app-flow";

export default async function NewAppPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; project?: string; name?: string; image?: string; template?: string; source?: string }>;
}) {
  const { parent: preselectedParentId, project: preselectedProjectId, name: prefilledName, image: prefilledImage, template: prefilledTemplate, source: preselectedSource } = await searchParams;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const [templatesEnabled, parentAppList, instanceConfig, containerImportEnabled, lastApp] = await Promise.all([
    isFeatureEnabledAsync("templates"),
    // Load projects for grouping
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, color: true },
      orderBy: [asc(projects.name)],
    }),
    getInstanceConfig(),
    isFeatureEnabledAsync("container-import"),
    // Most recently used project, for preselection
    db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), isNotNull(apps.projectId)),
      columns: { projectId: true },
      orderBy: [desc(apps.createdAt)],
    }),
  ]);

  const templateList = templatesEnabled ? await loadTemplates() : [];

  const parentOptions = parentAppList.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color || "#6366f1",
  }));

  // Strip non-serialisable properties before passing to client component
  const cleanTemplates = JSON.parse(JSON.stringify(templateList));

  return (
    <NewAppFlow
      orgId={orgId}
      orgSlug={orgData.organization.slug}
      templates={cleanTemplates}
      parentApps={parentOptions}
      baseDomain={orgData.organization.baseDomain || instanceConfig.baseDomain}
      recentProjectId={
        parentAppList.some((p) => p.id === lastApp?.projectId)
          ? (lastApp?.projectId ?? undefined)
          : undefined
      }
      defaultParentId={preselectedParentId}
      defaultProjectId={preselectedProjectId}
      defaultName={prefilledName}
      defaultImage={prefilledImage}
      defaultTemplate={prefilledTemplate}
      defaultSource={preselectedSource}
      containerImportEnabled={containerImportEnabled}
    />
  );
}
