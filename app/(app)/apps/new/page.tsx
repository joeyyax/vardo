import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { NewAppFlow } from "./new-app-flow";

export default async function NewAppPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; name?: string; image?: string; template?: string }>;
}) {
  const { parent: preselectedParentId, name: prefilledName, image: prefilledImage, template: prefilledTemplate } = await searchParams;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const [templateList, parentAppList] = await Promise.all([
    loadTemplates(),
    // Load projects for grouping
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, color: true },
      orderBy: [asc(projects.name)],
    }),
  ]);

  const parentOptions = parentAppList.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color || "#6366f1",
  }));

  // Strip symbol properties from TOML parser output
  const cleanTemplates = JSON.parse(JSON.stringify(templateList));

  return (
    <NewAppFlow
      orgId={orgId}
      orgSlug={orgData.organization.slug}
      templates={cleanTemplates}
      parentApps={parentOptions}
      defaultParentId={preselectedParentId}
      defaultName={prefilledName}
      defaultImage={prefilledImage}
      defaultTemplate={prefilledTemplate}
    />
  );
}
