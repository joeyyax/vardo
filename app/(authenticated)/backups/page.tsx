import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isAppAdmin } from "@/lib/auth/admin";
import { getFlagConfig, isFeatureEnabledAsync } from "@/lib/config/features";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { BackupPage } from "@/components/backups/backup-page";

export default async function BackupsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

  const backupsEnabled = await isFeatureEnabledAsync("backups");

  const appList = backupsEnabled
    ? await db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        columns: { id: true, name: true, displayName: true },
      })
    : [];

  const flag = getFlagConfig("backups");

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Backups</h1>
      </PageToolbar>

      {backupsEnabled ? (
        <>
          <p className="type-body-sm text-muted-foreground max-w-2xl">
            Manage backup targets, schedules and retention for your organization.
          </p>

          <BackupPage scope="org" orgId={orgId} apps={appList} showIntro={false} />
        </>
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
