import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ReportsPageContent } from "./reports-page-content";
import { DEFAULT_ORG_FEATURES } from "@/lib/db/schema";

export default async function ReportsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const features = orgData.organization.features || DEFAULT_ORG_FEATURES;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">
          Analytics and business insights
        </p>
      </div>

      <ReportsPageContent
        orgId={orgData.organization.id}
        features={features}
      />
    </div>
  );
}
