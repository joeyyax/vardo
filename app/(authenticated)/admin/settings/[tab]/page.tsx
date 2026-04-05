import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { GeneralSettings } from "../general-settings";
import { EmailSettings } from "@/components/notifications/settings";
import { AuthSettings } from "../auth-settings";
import { FeatureFlagsSettings } from "../feature-flags-settings";
import { BackupSettings } from "@/components/backups/settings";
import { GitHubSettings } from "@/components/git-integration/settings";
import { DomainSettings } from "@/components/ssl/domain-settings";
import { InstancesSettings } from "../instances-settings";
import { ConfigSettings } from "../config-settings";
import { TraefikSettings } from "@/components/ssl/traefik-settings";
import { ExternalRoutesSettings } from "@/components/ssl/external-routes-settings";
import { MaintenanceSettings } from "../maintenance-settings";
import { BackupPage } from "@/components/backups/backup-page";

// ---------------------------------------------------------------------------
// Tab registry — maps URL slugs to components and optional feature gates.
// When a gate is set, the tab returns 404 if that feature flag is disabled.
// ---------------------------------------------------------------------------

type TabEntry = {
  component: React.ComponentType;
  gate?: FeatureFlag;
};

const TABS: Record<string, TabEntry> = {
  general:            { component: GeneralSettings },
  email:              { component: EmailSettings, gate: "notifications" },
  authentication:     { component: AuthSettings },
  "feature-flags":    { component: FeatureFlagsSettings },
  backup:             { component: BackupSettings, gate: "backups" },
  github:             { component: GitHubSettings, gate: "git-integration" },
  domain:             { component: DomainSettings, gate: "ssl" },
  traefik:            { component: TraefikSettings, gate: "ssl" },
  "external-routes":  { component: ExternalRoutesSettings, gate: "ssl" },
  instances:          { component: InstancesSettings, gate: "mesh" },
  maintenance:        { component: MaintenanceSettings },
  config:             { component: ConfigSettings },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AdminSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  const entry = TABS[tab];
  if (!entry) notFound();

  // Check feature flag gate
  if (entry.gate && !(await isFeatureEnabledAsync(entry.gate))) {
    notFound();
  }

  // Backup tab — special case: full BackupPage with admin scope
  if (tab === "backup") {
    const orgData = await getCurrentOrg();
    const orgId = orgData?.organization.id;
    if (!orgId) return <BackupSettings />;

    const appList = await db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, displayName: true },
    });

    return <BackupPage scope="admin" orgId={orgId} apps={appList} />;
  }

  const Component = entry.component;
  return <Component />;
}
