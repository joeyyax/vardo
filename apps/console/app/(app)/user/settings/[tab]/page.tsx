import { notFound, redirect } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { account } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
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

  // Auth tab needs to know if user has a password account
  let hasPasswordAccount = false;
  if (validTab === "auth") {
    const session = await getSession();
    if (session?.user?.id) {
      const credentialAccount = await db.query.account.findFirst({
        where: and(
          eq(account.userId, session.user.id),
          eq(account.providerId, "credential"),
        ),
      });
      hasPasswordAccount = !!credentialAccount;
    }
  }

  return <TabContent tab={validTab} orgId={orgId} hasPasswordAccount={hasPasswordAccount} />;
}

function TabContent({ tab, orgId, hasPasswordAccount }: { tab: ValidTab; orgId: string | null; hasPasswordAccount: boolean }) {
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
          <PasswordManagement />
          <TwoFactorAuth hasPasswordAccount={hasPasswordAccount} />
          <ActiveSessions />
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
