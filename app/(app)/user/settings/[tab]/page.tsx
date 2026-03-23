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

const VALID_TABS = ["profile", "auth", "tokens", "connections"] as const;
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
  let orgId: string | null = null;
  if (validTab === "tokens") {
    const orgData = await getCurrentOrg();
    if (!orgData) redirect("/login");
    orgId = orgData.organization?.id ?? null;
  }

  return <TabContent tab={validTab} orgId={orgId} />;
}

function TabContent({ tab, orgId }: { tab: ValidTab; orgId: string | null }) {
  switch (tab) {
    case "profile":
      return (
        <div className="space-y-8">
          <AccountInfo />
          <ThemeSwitcher />
        </div>
      );
    case "auth":
      return (
        <div className="space-y-8">
          <PasswordManagement />
          <TwoFactorAuth />
          <ActiveSessions />
        </div>
      );
    case "tokens":
      if (!orgId) {
        return (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No organization selected. Create or join an organization to manage
              API tokens.
            </p>
          </div>
        );
      }
      return <ApiTokens orgId={orgId} />;
    case "connections":
      return <GitHubConnection />;
  }
}
