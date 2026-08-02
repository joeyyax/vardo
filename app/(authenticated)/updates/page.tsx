import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { PageToolbar } from "@/components/page-toolbar";
import { FleetUpdates } from "./fleet-updates";

export default async function UpdatesPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Updates</h1>
      </PageToolbar>

      <p className="type-body-sm text-muted-foreground max-w-2xl">
        Every image update pending across the fleet. Pinning writes the tag into compose — deploy
        each app to run it.
      </p>

      <FleetUpdates orgId={orgData.organization.id} />
    </div>
  );
}
