import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { templates } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { asc } from "drizzle-orm";
import { NewProjectFlow } from "./new-project-flow";

export default async function NewProjectPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const templateList = await db.query.templates.findMany({
    orderBy: [asc(templates.category), asc(templates.displayName)],
  });

  return (
    <NewProjectFlow
      orgId={orgData.organization.id}
      orgSlug={orgData.organization.slug}
      templates={templateList}
    />
  );
}
