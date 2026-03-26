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
import { ConfigSettings } from "../config-settings";
import { TraefikSettings } from "../traefik-settings";
import { ExternalRoutesSettings } from "../external-routes-settings";
import { BackupPage } from "@/components/backups/backup-page";

const VALID_TABS = ["overview", "general", "email", "authentication", "feature-flags", "backup", "github", "domain", "traefik", "external-routes", "instances", "config"] as const;
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
  "traefik": TraefikSettings,
  "external-routes": ExternalRoutesSettings,
  "instances": InstancesSettings,
  "config": ConfigSettings,
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

  // Backup tab — full BackupPage with admin scope (system targets are editable)
  if (tab === "backup") {
    const orgData = await getCurrentOrg();
    const orgId = orgData?.organization.id;
    if (!orgId) {
      const Component = TAB_COMPONENTS[tab as ValidTab];
      return <Component />;
    }

    const appList = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true },
    });

    return <BackupPage scope="admin" orgId={orgId} apps={appList} />;
  }

  const Component = TAB_COMPONENTS[tab as ValidTab];
  return <Component />;
}
