import { notFound } from "next/navigation";
import { OverviewSettings } from "../overview-settings";
import { GeneralSettings } from "../general-settings";
import { EmailSettings } from "../email-settings";
import { AuthSettings } from "../auth-settings";
import { FeatureFlagsSettings } from "../feature-flags-settings";
import { BackupSettings } from "../backup-settings";
import { GitHubSettings } from "../github-settings";
import { DomainSettings } from "../domain-settings";
import { InstancesSettings } from "../instances-settings";

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

export default async function AdminSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const Component = TAB_COMPONENTS[tab as ValidTab];
  return <Component />;
}
