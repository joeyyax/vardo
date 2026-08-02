import { redirect } from "next/navigation";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";
import { SettingsNav } from "@/components/settings-nav";

type NavItem = {
  label: string;
  href: string;
  /** Feature flag that must be enabled for this tab to appear. */
  gate?: FeatureFlag;
};

const ALL_NAV_ITEMS: NavItem[] = [
  { label: "Profile", href: "/user/settings/profile" },
  { label: "Authentication", href: "/user/settings/auth" },
  { label: "API tokens", href: "/user/settings/tokens", gate: "api-tokens" },
  { label: "Connections", href: "/user/settings/connections" },
  { label: "Notifications", href: "/user/settings/notifications" },
];

export default async function UserSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  // Filter by feature flag gates
  const navItems: { label: string; href: string }[] = [];
  for (const item of ALL_NAV_ITEMS) {
    if (item.gate && !(await isFeatureEnabledAsync(item.gate))) continue;
    navItems.push({ label: item.label, href: item.href });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="type-h1">
          Account settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, security, and preferences.
        </p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SettingsNav items={navItems} />
          </div>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
