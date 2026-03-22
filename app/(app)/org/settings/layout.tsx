import { redirect } from "next/navigation";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { SettingsNav } from "@/components/settings-nav";

const SETTINGS_TABS = [
  { label: "Shared variables", href: "/org/settings/variables" },
  { label: "Domains", href: "/org/settings/domains" },
  { label: "Notifications", href: "/org/settings/notifications" },
  { label: "Team", href: "/org/settings/team" },
  { label: "Invitations", href: "/org/settings/invitations" },
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization settings
        </h1>
        <OrgSwitcher
          currentOrgId={orgData.organization.id}
          organizations={organizations}
          collapsed={false}
        />
      </div>

      <SettingsNav items={SETTINGS_TABS} />

      <div className="pt-4">{children}</div>
    </div>
  );
}
