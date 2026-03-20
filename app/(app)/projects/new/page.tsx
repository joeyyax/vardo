import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { loadTemplates } from "@/lib/templates/load";
import { NewProjectFlow } from "./new-project-flow";

export default async function NewProjectPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const templateList = await loadTemplates();

  return (
    <NewProjectFlow
      orgId={orgData.organization.id}
      orgSlug={orgData.organization.slug}
      templates={templateList}
    />
  );
}
