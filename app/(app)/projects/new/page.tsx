import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { groups } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";
import { loadTemplates } from "@/lib/templates/load";
import { NewProjectFlow } from "./new-project-flow";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string; name?: string; image?: string; template?: string }>;
}) {
  const { group: preselectedGroupId, name: prefilledName, image: prefilledImage, template: prefilledTemplate } = await searchParams;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const [templateList, groupList] = await Promise.all([
    loadTemplates(),
    db.query.groups.findMany({
      where: eq(groups.organizationId, orgId),
      orderBy: [asc(groups.name)],
      columns: { id: true, name: true, color: true },
    }),
  ]);

  // Strip symbol properties from TOML parser output
  const cleanTemplates = JSON.parse(JSON.stringify(templateList));

  return (
    <NewProjectFlow
      orgId={orgId}
      orgSlug={orgData.organization.slug}
      templates={cleanTemplates}
      groups={groupList}
      defaultGroupId={preselectedGroupId}
      defaultName={prefilledName}
      defaultImage={prefilledImage}
      defaultTemplate={prefilledTemplate}
    />
  );
}
