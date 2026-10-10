import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { getFlagConfig, isFeatureEnabledAsync } from "@/lib/config/features";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { OrgCronPage } from "@/components/cron/org-cron-page";

export default async function CronPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const cronEnabled = await isFeatureEnabledAsync("cron");
  const flag = getFlagConfig("cron");

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Cron</h1>
      </PageToolbar>

      {cronEnabled ? (
        <OrgCronPage orgId={orgData.organization.id} />
      ) : (
        <FeatureDisabled
          name={flag.label}
          description={flag.description}
          canManage={await isAppAdmin()}
        />
      )}
    </div>
  );
}
