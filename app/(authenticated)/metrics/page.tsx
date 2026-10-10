import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadMetricsPage } from "@/lib/app-services/metrics";
import { getFlagConfig } from "@/lib/config/features";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { OrgMetrics } from "./org-metrics";

export default async function MetricsPage() {
  const actor = await currentActor();

  if (!actor) {
    redirect("/login");
  }

  const data = await pageData(loadMetricsPage(actor));
  const flag = getFlagConfig("metrics");

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Metrics</h1>
      </PageToolbar>

      {data.enabled ? (
        <OrgMetrics
          orgId={actor.org.id}
          apps={data.apps}
        />
      ) : (
        <FeatureDisabled
          name={flag.label}
          description={flag.description}
          canManage={actor.instanceAdmin}
        />
      )}
    </div>
  );
}
