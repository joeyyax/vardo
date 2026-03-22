import { notFound } from "next/navigation";
import { GeneralSettings } from "../general-settings";
import { EmailSettings } from "../email-settings";
import { AuthSettings } from "../auth-settings";
import { FeatureFlagsSettings } from "../feature-flags-settings";
import { BackupSettings } from "../backup-settings";
import { GitHubSettings } from "../github-settings";
import { InfrastructureSettings } from "../infrastructure-settings";
import { DomainSettings } from "../domain-settings";

const VALID_TABS = ["general", "email", "authentication", "feature-flags", "backup", "github", "infrastructure", "domain"] as const;
type ValidTab = (typeof VALID_TABS)[number];

const TAB_COMPONENTS: Record<ValidTab, React.ComponentType> = {
  "general": GeneralSettings,
  "email": EmailSettings,
  "authentication": AuthSettings,
  "feature-flags": FeatureFlagsSettings,
  "backup": BackupSettings,
  "github": GitHubSettings,
  "infrastructure": InfrastructureSettings,
  "domain": DomainSettings,
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
