import { redirect } from "next/navigation";

const VALID_TABS = ["variables", "domains", "notifications", "team", "invitations"];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;

  // Backward compat: redirect ?tab=X to /settings/X
  if (tab && VALID_TABS.includes(tab)) {
    redirect(`/settings/${tab}`);
  }

  // Default tab
  redirect("/settings/variables");
}
