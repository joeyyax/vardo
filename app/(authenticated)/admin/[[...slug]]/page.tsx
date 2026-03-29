import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { AdminPanel } from "../admin-panel";

const VALID_TABS = ["overview", "organizations", "users", "maintenance", "metrics"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

export default async function AdminPage({ params }: PageProps) {
  const { slug } = await params;
  const activeTab: ValidTab = (slug?.[0] && VALID_TABS.includes(slug[0] as ValidTab))
    ? slug[0] as ValidTab
    : "overview";

  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const dbUser = await db.query.user.findFirst({
    where: eq(user.id, session.user.id),
    columns: { isAppAdmin: true },
  });
  if (!dbUser?.isAppAdmin) redirect("/projects");

  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  return <AdminPanel activeTab={activeTab} orgId={orgData.organization.id} />;
}
