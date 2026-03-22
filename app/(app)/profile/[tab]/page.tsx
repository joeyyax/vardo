import { notFound, redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ProfileTabContent } from "./profile-tab-content";

const VALID_TABS = ["account", "security", "tokens", "connections", "appearance"] as const;
type ValidTab = (typeof VALID_TABS)[number];

export default async function ProfileTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const orgId = orgData.organization.id;

  return <ProfileTabContent tab={tab as ValidTab} orgId={orgId} />;
}
