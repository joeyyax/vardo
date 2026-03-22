import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { SettingsNav } from "@/components/settings-nav";

const NAV_ITEMS = [
  { label: "General", href: "/admin/settings/general" },
  { label: "Email", href: "/admin/settings/email" },
  { label: "Authentication", href: "/admin/settings/authentication" },
  { label: "Feature flags", href: "/admin/settings/feature-flags" },
  { label: "Backup storage", href: "/admin/settings/backup" },
  { label: "GitHub App", href: "/admin/settings/github" },
  { label: "Infrastructure", href: "/admin/settings/infrastructure" },
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

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">
          System settings
        </h1>
      </PageToolbar>

      <SettingsNav items={NAV_ITEMS} />

      <div>{children}</div>
    </div>
  );
}
