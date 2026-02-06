import { redirect } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";
import { TasksContent } from "./tasks-content";

export default async function TasksPage() {
  const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);

  if (!orgData || !session?.user?.id) {
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
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
      </div>

      <TasksContent orgId={organization.id} currentUserId={session.user.id} />
    </div>
  );
}
