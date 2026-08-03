import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { SettingsNav } from "@/components/settings-nav";
import { isFeatureEnabledAsync, type FeatureFlag } from "@/lib/config/features";

type NavItem = {
  label: string;
  href: string;
  order: number;
  /** Feature flag that must be enabled for this tab to appear. */
  gate?: FeatureFlag;
};

/**
 * All settings tabs in display order. Items with a `gate` only appear
 * when that feature flag is enabled.
 */
const ALL_NAV_ITEMS: NavItem[] = [
  { label: "General", href: "/admin/settings/general", order: 0 },
  { label: "Email", href: "/admin/settings/email", order: 5, gate: "notifications" },
  { label: "Authentication", href: "/admin/settings/authentication", order: 10 },
  { label: "Feature flags", href: "/admin/settings/feature-flags", order: 20 },
  { label: "Core services", href: "/admin/settings/core-services", order: 25 },
  { label: "Backups", href: "/admin/settings/backup", order: 30, gate: "backups" },
  { label: "GitHub App", href: "/admin/settings/github", order: 40, gate: "git-integration" },
  { label: "Domain & SSL", href: "/admin/settings/domain", order: 50, gate: "ssl" },
  { label: "Traefik", href: "/admin/settings/traefik", order: 55, gate: "ssl" },
  { label: "External routes", href: "/admin/settings/external-routes", order: 60, gate: "ssl" },
  { label: "Instances", href: "/admin/settings/instances", order: 70, gate: "mesh" },
  { label: "Maintenance", href: "/admin/settings/maintenance", order: 80 },
  { label: "Config", href: "/admin/settings/config", order: 100 },
];

export default async function AdminSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  if (!dbUser?.isAppAdmin) redirect("/projects");

  // Filter by feature flag gates
  const navItems: { label: string; href: string }[] = [];
  for (const item of ALL_NAV_ITEMS) {
    if (item.gate && !(await isFeatureEnabledAsync(item.gate))) continue;
    navItems.push({ label: item.label, href: item.href });
  }

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">
          System settings
        </h1>
      </PageToolbar>

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
