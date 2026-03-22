import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { NewProjectForm } from "./new-project-form";

export default async function NewProjectPage() {
  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New Project</h1>
      <NewProjectForm orgId={orgData.organization.id} />
    </div>
  );
}
