import { redirect } from "next/navigation";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { AccountSettings } from "./account-settings";
import { ThemeSwitcher } from "./theme-switcher";
import { GitHubConnection } from "./github-connection";

export default async function ProfilePage() {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  const orgData = await getCurrentOrg();
  const orgId = orgData?.organization.id;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and connected services.
        </p>
      </div>

      {orgId && <AccountSettings orgId={orgId} />}

      <ThemeSwitcher />
      <GitHubConnection />
    </div>
  );
}
