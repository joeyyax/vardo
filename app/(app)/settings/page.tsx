import { redirect } from "next/navigation";

const TAB_MAP: Record<string, string> = {
  variables: "/org/settings/variables",
  domains: "/org/settings/domains",
  notifications: "/org/settings/notifications",
  team: "/org/settings/team",
  invitations: "/org/settings/invitations",
};

export default async function SettingsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const target = (tab && TAB_MAP[tab]) || "/org/settings/variables";
  redirect(target);
}
