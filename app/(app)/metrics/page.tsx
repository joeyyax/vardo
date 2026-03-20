import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
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

  const projectList = await db.query.projects.findMany({
    where: eq(projects.organizationId, orgId),
    orderBy: [asc(projects.sortOrder), desc(projects.createdAt)],
    columns: {
      id: true,
      name: true,
      displayName: true,
      status: true,
    },
  });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
      </PageToolbar>

      <OrgMetrics orgId={orgId} projects={projectList} />
    </div>
  );
}
