import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { BackupPage } from "@/components/backups/backup-page";

export default async function BackupsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

  const appList = await db.query.apps.findMany({
    where: eq(apps.organizationId, orgId),
    columns: { id: true, name: true, displayName: true },
  });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
      </PageToolbar>

      <p className="text-sm text-muted-foreground max-w-2xl">
        Backups are snapshots of your app volumes — databases, uploads and any persistent data. They don&apos;t include container images, code or environment variables. Snapshots are stored offsite and can be restored with one click.
      </p>

      <BackupPage scope="org" orgId={orgId} apps={appList} />
    </div>
  );
}
