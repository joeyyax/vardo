import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SettingsNav } from "@/components/settings-nav";

const PROFILE_TABS = [
  { label: "Account", href: "/profile/account" },
  { label: "Security", href: "/profile/security" },
  { label: "Tokens", href: "/profile/tokens" },
  { label: "Connections", href: "/profile/connections" },
  { label: "Appearance", href: "/profile/appearance" },
];

export default async function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account and connected services.
        </p>
      </div>

      <SettingsNav items={PROFILE_TABS} basePath="/profile" />

      {children}
    </div>
  );
}
