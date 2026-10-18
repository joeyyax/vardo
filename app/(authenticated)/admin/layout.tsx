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

const SETTINGS_GROUPS: { label: string; items: SettingsItem[] }[] = [
  {
    label: "Platform",
    items: [
      { label: "This instance", href: "/admin/settings/general" },
      { label: "Resource limits", href: "/admin/settings/resources" },
      { label: "Built-in services", href: "/admin/settings/core-services" },
      { label: "Features", href: "/admin/settings/feature-flags" },
      { label: "Import & export", href: "/admin/settings/config" },
    ],
  },
  {
    label: "Access",
    items: [
      { label: "Sign-in", href: "/admin/settings/authentication" },
      { label: "Probe guard", href: "/admin/probe-guard" },
    ],
  },
  {
    label: "Network",
    items: [
      { label: "Domain & certificates", href: "/admin/settings/domain", gate: "ssl" },
      { label: "Proxy", href: "/admin/settings/traefik", gate: "ssl" },
      { label: "External routes", href: "/admin/settings/external-routes", gate: "ssl" },
      { label: "Linked instances", href: "/admin/settings/instances", gate: "mesh" },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Email", href: "/admin/settings/email", gate: "notifications" },
      { label: "Git providers", href: "/admin/settings/github", gate: "git-integration" },
    ],
  },
  {
    label: "Data",
    items: [
      { label: "Backups", href: "/admin/settings/backup", gate: "backups" },
      { label: "Maintenance", href: "/admin/settings/maintenance" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAppAdmin())) redirect("/projects");

  const settingsGroups: SettingsNavGroup[] = [];
  for (const group of SETTINGS_GROUPS) {
    const items: SettingsNavItem[] = [];
    for (const { gate, ...item } of group.items) {
      if (gate && !(await isFeatureEnabledAsync(gate))) continue;
      items.push(item);
    }
    settingsGroups.push({ label: group.label, items });
  }

  const groups: SettingsNavGroup[] = [
    {
      items: [
        { label: "Overview", href: "/admin", exact: true },
        { label: "Pipeline", href: "/admin/pipeline" },
        { label: "Apps", href: "/admin/apps" },
      ],
    },
{
    label: "Manage",
    items: [
      { label: "Organizations", href: "/admin/organizations" },
      { label: "Users", href: "/admin/users" },
      { label: "Security", href: "/admin/security" },
      { label: "Trust center", href: "/admin/trust" },
    ],
  },
    ...settingsGroups,
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
