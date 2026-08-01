import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import { getFlagConfig, isFeatureEnabledAsync } from "@/lib/config/features";
import { eq, asc, desc } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { OrgMetrics } from "./org-metrics";

export default async function MetricsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;
  const metricsEnabled = await isFeatureEnabledAsync("metrics");

  const appList = metricsEnabled
    ? await db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
        columns: { id: true, name: true, displayName: true, status: true },
      })
    : [];

  const flag = getFlagConfig("metrics");

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Metrics</h1>
      </PageToolbar>

      {metricsEnabled ? (
        <OrgMetrics
          orgId={orgId}
          apps={appList}
        />
      ) : (
        <FeatureDisabled
          name={flag.label}
          description={flag.description}
          canManage={await isAppAdmin()}
        />
      )}
    </div>
  );
}
