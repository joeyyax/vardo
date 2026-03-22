import { notFound, redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import {
  AccountInfo,
  PasswordManagement,
  TwoFactorAuth,
  ActiveSessions,
  ApiTokens,
} from "../account-settings";
import { ThemeSwitcher } from "../theme-switcher";
import { GitHubConnection } from "../github-connection";

const VALID_TABS = ["profile", "auth", "tokens", "connections", "appearance"] as const;
type ValidTab = (typeof VALID_TABS)[number];

export default async function UserSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const validTab = tab as ValidTab;

  // Tokens tab needs orgId
  let orgId: string | undefined;
  if (validTab === "tokens") {
    const orgData = await getCurrentOrg();
    if (!orgData) redirect("/login");
    orgId = orgData.organization.id;
  }

  return <TabContent tab={validTab} orgId={orgId} />;
}

function TabContent({ tab, orgId }: { tab: ValidTab; orgId?: string }) {
  switch (tab) {
    case "profile":
      return <AccountInfo />;
    case "auth":
      return (
        <div className="space-y-8">
          <PasswordManagement />
          <TwoFactorAuth />
          <ActiveSessions />
        </div>
      );
    case "tokens":
      return orgId ? <ApiTokens orgId={orgId} /> : null;
    case "connections":
      return <GitHubConnection />;
    case "appearance":
      return <ThemeSwitcher />;
  }
}
