import { redirect } from "next/navigation";
import { isAppAdmin } from "@/lib/auth/admin";
import { getSession } from "@/lib/auth/session";
import { AdminPanel } from "../admin-panel";

const VALID_TABS = ["overview", "organizations", "users"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function AdminPage({ params }: PageProps) {
  const { slug } = await params;

  // Maintenance lives under system settings.
  if (slug?.[0] === "maintenance") redirect("/admin/settings/maintenance");
  // Server metrics are the Metrics page's whole-server scope.
  if (slug?.[0] === "metrics") redirect("/metrics?scope=server");

  const activeTab: ValidTab = (slug?.[0] && VALID_TABS.includes(slug[0] as ValidTab))
    ? slug[0] as ValidTab
    : "overview";

  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  if (!(await isAppAdmin())) redirect("/projects");

  return <AdminPanel activeTab={activeTab} />;
}
