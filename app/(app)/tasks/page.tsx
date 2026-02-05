import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { TasksContent } from "./tasks-content";

export default async function TasksPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization } = orgData;

  // Merge org features with defaults
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  // If PM is not enabled, redirect to projects
  if (!features.pm) {
    redirect("/projects");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-muted-foreground">
            All tasks across your projects
          </p>
        </div>
      </div>

      <TasksContent orgId={organization.id} />
    </div>
  );
}
