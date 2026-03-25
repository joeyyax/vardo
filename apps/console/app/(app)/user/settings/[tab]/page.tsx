import { notFound, redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import {
  AccountInfo,
  PasskeyManager,
  LinkedAccounts,
  AuthInfo,
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
        <div className="space-y-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">Profile</h2>
              <p className="text-sm text-muted-foreground">
                Your identity across the platform — how others see you in teams and activity feeds.
              </p>
            </div>
            <ThemeSwitcher />
          </div>
          <AccountInfo />
        </div>
      );
    case "auth":
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Authentication</h2>
            <p className="text-sm text-muted-foreground">
              Manage how you sign in and protect your account.
            </p>
          </div>
          <PasskeyManager />
          <LinkedAccounts />
          <ActiveSessions />
          <AuthInfo />
        </div>
      );
    case "tokens":
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold">API tokens</h2>
            <p className="text-sm text-muted-foreground">
              Create tokens for CI/CD pipelines, scripts, and external integrations.
            </p>
          </div>
          {!orgId ? (
            <div className="rounded-xl border bg-card p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No organization selected. Create or join an organization to manage
                API tokens.
              </p>
            </div>
          ) : (
            <ApiTokens orgId={orgId} />
          )}
        </div>
      );
    case "connections":
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Connections</h2>
            <p className="text-sm text-muted-foreground">
              Link external accounts to enable repo imports and auto-deploy.
            </p>
          </div>
          <GitHubConnection />
        </div>
      );
  }
}
