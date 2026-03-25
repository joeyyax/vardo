import { redirect } from "next/navigation";

const TAB_MAP: Record<string, string> = {
  general: "/settings/general",
  variables: "/settings/variables",
  domains: "/settings/domains",
  notifications: "/settings/notifications",
  team: "/settings/team",
  invitations: "/settings/invitations",
};

export default async function SettingsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const target = (tab && TAB_MAP[tab]) || "/settings/general";
  redirect(target);
}
