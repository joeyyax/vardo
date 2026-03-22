import { notFound } from "next/navigation";
import { GeneralSettings } from "../general-settings";
import { EmailSettings } from "../email-settings";
import { BackupSettings } from "../backup-settings";
import { GitHubSettings } from "../github-settings";
import { ServicesSettings } from "../services-settings";

const VALID_TABS = ["general", "email", "backup", "github", "services"] as const;
type ValidTab = (typeof VALID_TABS)[number];

const TAB_COMPONENTS: Record<ValidTab, React.ComponentType> = {
  general: GeneralSettings,
  email: EmailSettings,
  backup: BackupSettings,
  github: GitHubSettings,
  services: ServicesSettings,
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
