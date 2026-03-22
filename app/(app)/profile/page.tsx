import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { Settings, Users } from "lucide-react";
import { GitHubConnection } from "./github-connection";
import { ThemeSwitcher } from "./theme-switcher";

export default async function ProfilePage() {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  const orgData = await getCurrentOrg();
  const orgName = orgData?.organization.name;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and connected services.
        </p>
      </div>

      {orgName && (
        <div>
          <h2 className="text-base font-semibold">{orgName}</h2>
          <div className="mt-3 flex gap-3">
            <Link
              href="/settings"
              className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium hover:bg-accent transition-colors"
            >
              <Settings className="size-4 text-muted-foreground" />
              Settings
            </Link>
            <Link
              href="/team"
              className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium hover:bg-accent transition-colors"
            >
              <Users className="size-4 text-muted-foreground" />
              Team
            </Link>
          </div>
        </div>
      )}

      <ThemeSwitcher />
      <GitHubConnection />
    </div>
  );
}
