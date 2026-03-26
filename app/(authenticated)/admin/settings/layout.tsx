import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { SettingsNav } from "@/components/settings-nav";
import { isFeatureEnabledAsync } from "@/lib/config/features";

const BASE_NAV_ITEMS = [
  { label: "Overview", href: "/admin/settings/overview" },
  { label: "General", href: "/admin/settings/general" },
  { label: "Email", href: "/admin/settings/email" },
  { label: "Authentication", href: "/admin/settings/authentication" },
  { label: "Feature flags", href: "/admin/settings/feature-flags" },
  { label: "Backups", href: "/admin/settings/backup" },
  { label: "GitHub App", href: "/admin/settings/github" },
  { label: "Domain & SSL", href: "/admin/settings/domain" },
  { label: "Traefik", href: "/admin/settings/traefik" },
  { label: "Config", href: "/admin/settings/config" },
];

export default async function AdminSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const [dbUser, meshEnabled] = await Promise.all([
    db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { isAppAdmin: true },
    }),
    isFeatureEnabledAsync("mesh"),
  ]);
  if (!dbUser?.isAppAdmin) redirect("/projects");

  const navItems = meshEnabled
    ? [...BASE_NAV_ITEMS, { label: "Instances", href: "/admin/settings/instances" }]
    : BASE_NAV_ITEMS;

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">
          System settings
        </h1>
      </PageToolbar>

      <SettingsNav items={navItems} />

      <div>{children}</div>
    </div>
  );
}
