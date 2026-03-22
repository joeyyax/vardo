import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, desc } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { ActivityFeed } from "./activity-feed";

export default async function ActivityPage() {
  const orgData = await getCurrentOrg();
  if (!orgData) redirect("/login");

  const orgId = (orgData.organization as { id: string }).id;

  const recentActivities = await db.query.activities.findMany({
    where: eq(activities.organizationId, orgId),
    with: {
      user: { columns: { id: true, name: true, email: true, image: true } },
      app: { columns: { id: true, name: true, displayName: true } },
    },
    orderBy: [desc(activities.createdAt)],
    limit: 50,
  });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      </PageToolbar>
      <ActivityFeed activities={recentActivities} orgId={orgId} />
    </div>
  );
}
