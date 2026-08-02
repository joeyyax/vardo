import { redirect } from "next/navigation";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { SettingsNav } from "@/components/settings-nav";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";

type SettingsTab = {
  label: string;
  href: string;
  /** Feature flag that must be enabled for this tab to appear. */
  gate?: FeatureFlag;
};

const SETTINGS_TABS: SettingsTab[] = [
  { label: "General", href: "/settings/general" },
  { label: "Shared variables", href: "/settings/variables" },
  { label: "Domains", href: "/settings/domains" },
  { label: "Backups", href: "/settings/backups" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Team", href: "/settings/team", gate: "teams" },
  { label: "Invitations", href: "/settings/invitations", gate: "teams" },
];

export default async function OrgSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const orgData = await getCurrentOrg();

  if (!orgData || !session?.user?.id) {
    redirect("/onboarding");
  }

  const organizations = await getUserOrganizations();
  const teamsEnabled = await isFeatureEnabledAsync("teams");

  const navItems: { label: string; href: string }[] = [];
  for (const item of SETTINGS_TABS) {
    if (item.gate && !(await isFeatureEnabledAsync(item.gate))) continue;
    navItems.push({ label: item.label, href: item.href });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="type-h1">
          Organization settings
        </h1>
        {teamsEnabled && (
          <OrgSwitcher
            currentOrgId={orgData.organization.id}
            organizations={organizations}
            collapsed={false}
          />
        )}
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
