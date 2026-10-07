import { redirect } from "next/navigation";
import { isAppAdmin } from "@/lib/auth/admin";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { getFlagConfig, isFeatureEnabledAsync } from "@/lib/config/features";
import { AdminPanel } from "../admin-panel";

const VALID_TABS = ["overview", "organizations", "users", "metrics"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function AdminPage({ params }: PageProps) {
  const { slug } = await params;

  // Maintenance lives under system settings.
  if (slug?.[0] === "maintenance") redirect("/admin/settings/maintenance");

  const activeTab: ValidTab = (slug?.[0] && VALID_TABS.includes(slug[0] as ValidTab))
    ? slug[0] as ValidTab
    : "overview";

  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  if (!(await isAppAdmin())) redirect("/projects");

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const metricsEnabled = await isFeatureEnabledAsync("metrics");
  const { label, description } = getFlagConfig("metrics");

  return (
    <AdminPanel
      activeTab={activeTab}
      orgId={orgData.organization.id}
      metricsEnabled={metricsEnabled}
      metricsFlag={{ label, description }}
    />
  );
}
