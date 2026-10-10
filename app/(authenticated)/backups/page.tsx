import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadBackupsPage } from "@/lib/app-services/backups";
import { getFlagConfig } from "@/lib/config/features";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { BackupPage } from "@/components/backups/backup-page";

export default async function BackupsPage() {
  const actor = await currentActor();

  if (!actor) {
    redirect("/onboarding");
  }

  const data = await pageData(loadBackupsPage(actor));
  const flag = getFlagConfig("backups");

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Backups</h1>
      </PageToolbar>

      {data.enabled ? (
        <>
          <p className="type-body-sm text-muted-foreground max-w-2xl">
            Manage backup targets, schedules and retention for your organization.
          </p>

          <BackupPage scope="org" orgId={actor.org.id} apps={data.apps} showIntro={false} />
        </>
      ) : (
        <FeatureDisabled
          name={flag.label}
          description={flag.description}
          canManage={actor.instanceAdmin}
        />
      )}
    </div>
  );
}
