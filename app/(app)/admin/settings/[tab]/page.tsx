import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { OverviewSettings } from "../overview-settings";
import { GeneralSettings } from "../general-settings";
import { EmailSettings } from "../email-settings";
import { AuthSettings } from "../auth-settings";
import { FeatureFlagsSettings } from "../feature-flags-settings";
import { BackupSettings } from "../backup-settings";
import { GitHubSettings } from "../github-settings";
import { DomainSettings } from "../domain-settings";
import { InstancesSettings } from "../instances-settings";
import { BackupPage } from "@/components/backups/backup-page";

const VALID_TABS = ["overview", "general", "email", "authentication", "feature-flags", "backup", "github", "domain", "instances"] as const;
type ValidTab = (typeof VALID_TABS)[number];

const TAB_COMPONENTS: Record<ValidTab, React.ComponentType> = {
  "overview": OverviewSettings,
  "general": GeneralSettings,
  "email": EmailSettings,
  "authentication": AuthSettings,
  "feature-flags": FeatureFlagsSettings,
  "backup": BackupSettings,
  "github": GitHubSettings,
  "domain": DomainSettings,
  "instances": InstancesSettings,
};

/** Tabs that require a feature flag to be enabled. */
const FLAG_GATED_TABS: Partial<Record<ValidTab, Parameters<typeof isFeatureEnabledAsync>[0]>> = {
  instances: "mesh",
};

export default async function AdminSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const requiredFlag = FLAG_GATED_TABS[tab as ValidTab];
  if (requiredFlag && !(await isFeatureEnabledAsync(requiredFlag))) {
    notFound();
  }

  // Backup tab needs special handling — renders BackupPage with admin scope
  if (tab === "backup") {
    const orgData = await getCurrentOrg();
    const orgId = orgData?.organization.id;
    if (!orgId) return <BackupSettings />;

    const appList = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true },
    });

    return (
      <div className="space-y-8">
        <BackupSettings />
        <div className="border-t pt-8">
          <BackupPage scope="admin" orgId={orgId} apps={appList} />
        </div>
      </div>
    );
  }

  const Component = TAB_COMPONENTS[tab as ValidTab];
  return <Component />;
}
