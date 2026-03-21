import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { BackupManager } from "./backup-manager";

export default async function BackupsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

  // Fetch apps for the job creation form
  const appList = await db.query.apps.findMany({
    where: eq(apps.organizationId, orgId),
    columns: { id: true, name: true, displayName: true },
  });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
      </PageToolbar>

      <BackupManager orgId={orgId} apps={appList} />
    </div>
  );
}
