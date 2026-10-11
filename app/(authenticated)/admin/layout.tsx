import { redirect } from "next/navigation";
import { isAppAdmin } from "@/lib/auth/admin";
import { getSession } from "@/lib/auth/session";
import { PageToolbar } from "@/components/page-toolbar";
import { SettingsNav, type SettingsNavGroup, type SettingsNavItem } from "@/components/settings-nav";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";

type SettingsItem = SettingsNavItem & {
  /** Feature flag that must be enabled for this tab to appear. */
  gate?: FeatureFlag;
};

const SETTINGS_ITEMS: SettingsItem[] = [
  { label: "General", href: "/admin/settings/general" },
  { label: "Email", href: "/admin/settings/email", gate: "notifications" },
  { label: "Authentication", href: "/admin/settings/authentication" },
  { label: "Feature flags", href: "/admin/settings/feature-flags" },
  { label: "Core services", href: "/admin/settings/core-services" },
  { label: "Resources", href: "/admin/settings/resources" },
  { label: "Backups", href: "/admin/settings/backup", gate: "backups" },
  { label: "GitHub App", href: "/admin/settings/github", gate: "git-integration" },
  { label: "Domain & SSL", href: "/admin/settings/domain", gate: "ssl" },
  { label: "Traefik", href: "/admin/settings/traefik", gate: "ssl" },
  { label: "External routes", href: "/admin/settings/external-routes", gate: "ssl" },
  { label: "Security", href: "/admin/settings/security" },
  { label: "Instances", href: "/admin/settings/instances", gate: "mesh" },
  { label: "Maintenance", href: "/admin/settings/maintenance" },
  { label: "Config", href: "/admin/settings/config" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAppAdmin())) redirect("/projects");

  const settings: SettingsNavItem[] = [];
  for (const { gate, ...item } of SETTINGS_ITEMS) {
    if (gate && !(await isFeatureEnabledAsync(gate))) continue;
    settings.push(item);
  }

  const groups: SettingsNavGroup[] = [
    { items: [{ label: "Overview", href: "/admin", exact: true }] },
    {
      label: "Manage",
      items: [
        { label: "Organizations", href: "/admin/organizations" },
        { label: "Users", href: "/admin/users" },
      ],
    },
    { label: "Settings", items: settings },
  ];

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Admin</h1>
      </PageToolbar>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SettingsNav label="Admin sections" groups={groups} />
          </div>
        </aside>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
