import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, asc, isNull } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { NewProjectFlow } from "./new-project-flow";

export default async function NewProjectPage({
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

  const [templateList, parentProjectList] = await Promise.all([
    loadTemplates(),
    // Load projects that could be parents (top-level projects without a parent)
    db.query.projects.findMany({
      where: and(eq(projects.organizationId, orgId), isNull(projects.parentId)),
      columns: { id: true, name: true, color: true },
      orderBy: [asc(projects.name)],
    }),
  ]);

  const parentOptions = parentProjectList.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color || "#6366f1",
  }));

  // Strip symbol properties from TOML parser output
  const cleanTemplates = JSON.parse(JSON.stringify(templateList));

  return (
    <NewProjectFlow
      orgId={orgId}
      orgSlug={orgData.organization.slug}
      templates={cleanTemplates}
      parentProjects={parentOptions}
      defaultParentId={preselectedParentId}
      defaultName={prefilledName}
      defaultImage={prefilledImage}
      defaultTemplate={prefilledTemplate}
    />
  );
}
