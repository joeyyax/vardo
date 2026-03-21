import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, asc, desc } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { OrgMetrics } from "./org-metrics";

export default async function MetricsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const [appList, [{ projectCount }]] = await Promise.all([
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
      columns: { id: true, name: true, displayName: true, status: true },
    }),
    db.select({ projectCount: sql<number>`count(*)` })
      .from(projects)
      .where(eq(projects.organizationId, orgId)),
  ]);

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
      </PageToolbar>

      <OrgMetrics
        orgId={orgId}
        apps={appList}
        projectCount={Number(projectCount)}
      />
    </div>
  );
}
